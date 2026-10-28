import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import * as vscode from 'vscode';
import {
  DocSync, FileStateStore, NodeWorkspace, Responder, Session, acquireLock, policyFromRoom, releaseLock, runAgent,
  detectProvider, type AgentHost, type StoredSession, type SyncReport,
} from '@codemeet/core';
import type { Participant, Provider, ProposalView, RoomScope, ServerEvent, SharingPolicy } from '@codemeet/shared';
import { CursorDecorationManager } from './services/cursor/CursorDecorationManager';
import { SidebarProvider, type SidebarAction } from './sidebar';
import { emptyState, type UiState } from './uiState';
import { VsCodeWorkspace } from './vscodeWorkspace';

interface SavedSecret {
  creds: StoredSession;
  role: 'host' | 'guest';
}

/**
 * Owns exactly one collaboration session for the open folder. Everything created for a session
 * lives in `sessionDisposables`/fields that {@link teardown} releases, so starting and stopping is
 * idempotent and membership changes never restart sync services.
 */
export class Controller implements vscode.Disposable {
  private state: UiState = emptyState();
  private session: Session | null = null;
  private sync: DocSync | null = null;
  private responder: Responder | null = null;
  private ws: VsCodeWorkspace | null = null;
  private starting = false;
  /** True while this machine is deliberately closing/leaving, so the server's own room-closed echo is not treated as a surprise. */
  private closing = false;
  private readonly proposals = new Map<string, ProposalView>();
  private readonly agentIds: Partial<Record<Provider, string>> = {};
  private sessionDisposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private cursors: CursorDecorationManager | null = null;
  private readonly status: vscode.StatusBarItem;
  readonly sidebar: SidebarProvider;
  readonly proposalDocs: ProposalDocs;
  private readonly changeEmitter = new vscode.EventEmitter<string>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly out: vscode.OutputChannel,
  ) {
    this.sidebar = new SidebarProvider((a) => void this.onSidebarAction(a));
    this.proposalDocs = new ProposalDocs(this.proposals, this.changeEmitter.event);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'codemeet.leaveRoom';
    this.publish();
  }

  // ── helpers ──

  private root(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a folder first: CodeMeet shares the open workspace folder.');
    if (folder.uri.scheme !== 'file') throw new Error('CodeMeet needs a local folder (virtual workspaces are not supported).');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace first: CodeMeet reads and writes files in the folder.');
    return folder.uri.fsPath;
  }

  private cfg(): { serverUrl: string; displayName: string } {
    const c = vscode.workspace.getConfiguration('codemeet');
    return { serverUrl: (c.get<string>('serverUrl') ?? 'http://127.0.0.1:3001').replace(/\/+$/, ''), displayName: c.get<string>('displayName') ?? '' };
  }

  private async askName(): Promise<string | undefined> {
    const def = this.cfg().displayName;
    const name = await vscode.window.showInputBox({ prompt: 'Your display name (what coworkers see)', value: def, validateInput: (v) => (v.trim() ? null : 'A name is required') });
    return name?.trim();
  }

  private secretKey(root: string): string {
    return `codemeet.session:${root}`;
  }

  get active(): boolean {
    return this.session !== null;
  }

  private publish(): void {
    const s = this.state;
    this.sidebar.update(s);
    if (s.phase === 'idle') {
      this.status.hide();
      return;
    }
    const icon = s.phase === 'syncing' ? '$(broadcast)' : s.phase === 'offline' ? '$(debug-disconnect)' : '$(sync~spin)';
    this.status.text = `${icon} CodeMeet ${s.roomId}`;
    this.status.tooltip = `${s.phase}${s.detail ? `: ${s.detail}` : ''} - click to leave`;
    this.status.show();
  }

  private patch(p: Partial<UiState>): void {
    this.state = { ...this.state, ...p };
    this.publish();
  }

  private refreshFromSession(): void {
    const snap = this.session?.snapshot;
    if (!snap) return;
    this.patch({ participants: snap.participants, pending: snap.pending });
  }

  // ── commands: lifecycle ──

  async createRoom(): Promise<void> {
    if (this.active || this.starting) return void vscode.window.showWarningMessage('You are already in a CodeMeet session.');
    const root = this.root();
    const name = await this.askName();
    if (!name) return;
    const password = await vscode.window.showInputBox({ prompt: 'Room password (collaborators need it)', password: true, validateInput: (v) => (v.length < 3 ? 'At least 3 characters' : null) });
    if (!password) return;
    const scope = await vscode.window.showQuickPick<{ label: string; value: RoomScope; description: string }>(
      [
        { label: 'Whole workspace', value: 'workspace', description: 'Everything not ignored or secret' },
        { label: 'One folder', value: 'folder', description: 'Only the folder you pick' },
        { label: 'One file', value: 'file', description: 'Only the active file' },
      ],
      { placeHolder: 'What do you want to share?' },
    );
    if (!scope) return;
    let scopePath: string | undefined;
    if (scope.value === 'file') {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return void vscode.window.showWarningMessage('Open the file you want to share first.');
      scopePath = path.relative(root, ed.document.uri.fsPath).split(path.sep).join('/');
    } else if (scope.value === 'folder') {
      const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(root), openLabel: 'Share this folder' });
      if (!pick?.[0]) return;
      scopePath = path.relative(root, pick[0].fsPath).split(path.sep).join('/');
      if (!scopePath || scopePath.startsWith('..')) return void vscode.window.showErrorMessage('Pick a folder inside the workspace.');
    }
    await this.hostWith({ name, password, scope: scope.value, scopePath }).catch(() => undefined);
  }

  /** Creates a room and starts syncing. Shared by the prompt-driven command and the e2e seam. */
  async hostWith(o: { name: string; password: string; scope: RoomScope; scopePath?: string; serverUrl?: string }): Promise<void> {
    if (this.active || this.starting) throw new Error('You are already in a CodeMeet session.');
    const root = this.root();
    this.starting = true;
    try {
      const cfg = this.cfg();
      const session = new Session(o.serverUrl ?? cfg.serverUrl);
      let codeignore = '';
      try {
        codeignore = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(root, '.codeignore')))).toString('utf8').slice(0, 20_000);
      } catch {
        /* no .codeignore */
      }
      const creds = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creating CodeMeet room...' }, () =>
        session.create({ displayName: o.name, password: o.password, scope: o.scope, scopePath: o.scopePath, codeignore, projectName: path.basename(root) }),
      );
      await this.begin(session, 'host', creds, 'new');
      void vscode.window.showInformationMessage(`Room ${creds.roomId} created. Share the ID and password with collaborators.`);
    } catch (e) {
      await this.teardown();
      void vscode.window.showErrorMessage(`CodeMeet: ${(e as Error).message}`);
      throw e;
    } finally {
      this.starting = false;
    }
  }

  async joinRoom(): Promise<void> {
    if (this.active || this.starting) return void vscode.window.showWarningMessage('You are already in a CodeMeet session.');
    this.root();
    const roomId = (await vscode.window.showInputBox({ prompt: 'Room ID', validateInput: (v) => (v.trim() ? null : 'Required') }))?.trim();
    if (!roomId) return;
    const password = await vscode.window.showInputBox({ prompt: 'Room password', password: true });
    if (!password) return;
    const name = await this.askName();
    if (!name) return;
    await this.joinWith({ roomId, password, name }).catch(() => undefined);
  }

  async joinWith(o: { roomId: string; password: string; name: string; serverUrl?: string }): Promise<void> {
    if (this.active || this.starting) throw new Error('You are already in a CodeMeet session.');
    this.root();
    this.starting = true;
    try {
      const session = new Session(o.serverUrl ?? this.cfg().serverUrl);
      const creds = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Waiting for the host to approve you...', cancellable: true },
        (_p, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return session.join({ roomId: o.roomId, password: o.password, displayName: o.name }, { signal: abort.signal });
        },
      );
      await this.begin(session, 'guest', creds, 'new');
    } catch (e) {
      await this.teardown();
      void vscode.window.showErrorMessage(`CodeMeet: ${(e as Error).message}`);
      throw e;
    } finally {
      this.starting = false;
    }
  }

  /** Reconnects to a saved session after VS Code restarts. */
  async resumeSaved(): Promise<void> {
    let root: string;
    try {
      root = this.root();
    } catch {
      return;
    }
    const raw = await this.ctx.secrets.get(this.secretKey(root));
    if (!raw || this.active || this.starting) return;
    let saved: SavedSecret;
    try {
      saved = JSON.parse(raw) as SavedSecret;
    } catch {
      return;
    }
    this.starting = true;
    try {
      const session = new Session(saved.creds.serverUrl);
      await session.resume(saved.creds);
      await this.begin(session, saved.role, saved.creds, 'resume');
      void vscode.window.showInformationMessage(`CodeMeet: resumed room ${saved.creds.roomId}.`);
    } catch (e) {
      await this.teardown();
      await this.ctx.secrets.delete(this.secretKey(root));
      void vscode.window.showWarningMessage(`CodeMeet could not resume room ${saved.creds.roomId}: ${(e as Error).message}`);
    } finally {
      this.starting = false;
    }
  }

  async leaveRoom(): Promise<void> {
    if (!this.session) return;
    const host = this.state.role === 'host';
    const choices = host ? ['Close room for everyone', 'Stop syncing (keep room open)'] : ['Leave room', 'Stop syncing (stay a member)'];
    const pick = await vscode.window.showWarningMessage(host ? 'Leave CodeMeet room?' : 'Leave CodeMeet room?', { modal: true, detail: 'Your files are never deleted.' }, ...choices);
    if (!pick) return;
    const permanent = pick === choices[0];
    const root = this.ws?.root;
    this.closing = true;
    try {
      if (permanent) await this.session.call(host ? 'room.close' : 'room.leave', {}).catch(() => undefined);
    } finally {
      await this.teardown();
      this.closing = false;
      if (permanent && root) await this.ctx.secrets.delete(this.secretKey(root));
    }
  }

  // ── session start ──

  private async begin(session: Session, role: 'host' | 'guest', creds: StoredSession, mode: 'new' | 'resume'): Promise<void> {
    const root = this.root();
    acquireLock(root, { pid: process.pid, kind: 'extension', roomId: creds.roomId });
    this.session = session;
    this.state = { ...emptyState(), phase: 'starting', roomId: creds.roomId, serverUrl: creds.serverUrl, role };
    this.publish();

    const room = session.snapshot!.room;
    const policy = policyFromRoom(room);
    const ws = new VsCodeWorkspace(new NodeWorkspace(root, policy), root);
    this.ws = ws;
    const sync = new DocSync(session, ws, policy, new FileStateStore(root, creds.roomId));
    this.sync = sync;
    sync.on('log', (l) => this.out.appendLine(l));
    sync.on('skipped', (s) => this.out.appendLine(`skipped ${s.path}: ${s.reason}`));
    sync.on('remoteChange', (c) => this.out.appendLine(`remote ${c.kind}: ${c.path}`));
    this.cursors = new CursorDecorationManager();

    // Ignore anything from a session that has since been replaced or torn down.
    session.on('evt', (e) => this.session === session && this.onEvent(e));
    session.on('state', (s, detail) => this.session === session && this.onSessionState(s, detail));

    if (mode === 'new') {
      if (role === 'host') this.report(await sync.publishBaseline());
      else {
        let report = await sync.pullBaseline();
        if (report.conflicts.length) {
          const list = report.conflicts.slice(0, 8).map((c) => c.path).join('\n');
          const ok = await vscode.window.showWarningMessage(
            `${report.conflicts.length} local file(s) differ from the shared project and would be replaced.`,
            { modal: true, detail: `${list}\n\nOriginals are backed up under .codemeet/backups/ first.` },
            'Back up and use shared versions',
          );
          if (!ok) throw new Error('Joining cancelled; no local files were changed.');
          report = await sync.pullBaseline({ acceptBaseline: true });
        }
        this.report(report);
      }
    } else {
      await sync.restore();
      await sync.resync();
      await sync.reconcileAll();
    }
    await this.ctx.secrets.store(this.secretKey(root), JSON.stringify({ creds, role } satisfies SavedSecret));

    this.wireEditorEvents(root, ws, sync, policy);
    this.responder = new Responder({ session, agentIds: () => this.agentIds, log: (l) => this.out.appendLine(l) });
    await this.responder.start();

    const [proposals, grants, messages, activity] = await Promise.all([
      session.call('proposal.list', {}), session.call('consent.list', {}), session.call('msg.list', {}), session.call('activity.list', { limit: 50 }),
    ]);
    for (const p of proposals.proposals) this.proposals.set(p.id, p);
    this.patch({
      phase: 'syncing', detail: '', participants: session.snapshot!.participants, pending: session.snapshot!.pending,
      proposals: [...this.proposals.values()], grants: grants.grants, messages: messages.messages, activity: activity.entries,
    });
    for (const req of session.snapshot!.pending) void this.promptJoin(req.id, req.displayName);
  }

  private report(r: SyncReport): void {
    const parts = [];
    if (r.uploaded.length) parts.push(`shared ${r.uploaded.length} file(s)`);
    if (r.downloaded.length) parts.push(`downloaded ${r.downloaded.length}`);
    if (r.localOnly.length) parts.push(`${r.localOnly.length} local-only file(s) stay private`);
    if (r.skipped.length) parts.push(`${r.skipped.length} skipped`);
    this.out.appendLine(`baseline: ${parts.join(', ') || 'nothing to sync'}`);
    for (const s of r.skipped.slice(0, 20)) this.out.appendLine(`  skipped ${s.path}: ${s.reason}`);
  }

  private schedule(rel: string): void {
    const t = this.timers.get(rel);
    if (t) clearTimeout(t);
    this.timers.set(rel, setTimeout(() => {
      this.timers.delete(rel);
      void this.sync?.localChanged(rel);
    }, 30));
  }

  /** All editor/file listeners for the session; every one is released by teardown(). */
  private wireEditorEvents(root: string, ws: VsCodeWorkspace, sync: DocSync, policy: SharingPolicy): void {
    const rel = (uri: vscode.Uri): string | null => {
      if (uri.scheme !== 'file') return null;
      const r = path.relative(root, uri.fsPath);
      if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
      const p = r.split(path.sep).join('/');
      return policy.allows(p) ? p : null;
    };
    const d = this.sessionDisposables;
    d.push(vscode.workspace.onDidChangeTextDocument((e) => {
      const p = rel(e.document.uri);
      if (p && e.contentChanges.length) this.schedule(p);
    }));
    d.push(vscode.workspace.onDidCloseTextDocument((doc) => {
      const p = rel(doc.uri);
      if (p) void sync.materialize(p);
    }));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    const onDisk = (uri: vscode.Uri) => {
      const p = rel(uri);
      // Open files are driven by their buffer; only closed files are driven by disk events.
      if (p && !ws.openDocument(p)) this.schedule(p);
    };
    d.push(watcher, watcher.onDidChange(onDisk), watcher.onDidCreate(onDisk), watcher.onDidDelete(onDisk));
    d.push(vscode.workspace.onDidRenameFiles((e) => {
      for (const f of e.files) {
        const a = rel(f.oldUri);
        const b = rel(f.newUri);
        if (a && b) void sync.localRenamed(a, b);
      }
    }));
    let lastCursor = 0;
    d.push(vscode.window.onDidChangeTextEditorSelection((e) => {
      const p = rel(e.textEditor.document.uri);
      const now = Date.now();
      if (!p || now - lastCursor < 120 || !this.session?.connected) return;
      lastCursor = now;
      const pos = e.selections[0]?.active;
      if (pos) void this.session.call('presence.cursor', { path: p, line: pos.line, character: pos.character }).catch(() => undefined);
    }));
  }

  // ── session events ──

  private onSessionState(s: string, detail?: string): void {
    if (s === 'offline') this.patch({ phase: 'offline', detail: 'reconnecting automatically' });
    else if (s === 'online' && this.state.phase === 'offline') this.patch({ phase: 'syncing', detail: '' });
    else if (s === 'closed') {
      if (this.closing) return;
      void vscode.window.showWarningMessage(`CodeMeet room ended: ${detail ?? 'closed'}. Your local files are unchanged.`);
      void this.teardown(true);
    }
  }

  private onEvent(e: ServerEvent): void {
    switch (e.type) {
      case 'presence':
        this.refreshFromSession();
        break;
      case 'join-request':
        this.refreshFromSession();
        void this.promptJoin(e.request.id, e.request.displayName);
        break;
      case 'activity':
        this.patch({ activity: [...this.state.activity.slice(-49), e.entry] });
        break;
      case 'proposal': {
        const fresh = !this.proposals.has(e.proposal.id);
        this.proposals.set(e.proposal.id, e.proposal);
        this.changeEmitter.fire(e.proposal.id);
        this.patch({ proposals: [...this.proposals.values()].sort((a, b) => b.updatedAt - a.updatedAt) });
        if (fresh && e.proposal.status === 'pending') {
          void vscode.window.showInformationMessage(`${e.proposal.agentLabel} proposed: ${e.proposal.title}`, 'Review').then((c) => c && void this.reviewProposal(e.proposal.id));
        }
        break;
      }
      case 'consent':
        this.patch({ grants: e.grants });
        break;
      case 'message':
        this.patch({ messages: [...this.state.messages.filter((m) => m.id !== e.message.id), e.message].sort((a, b) => a.seq - b.seq) });
        break;
      case 'cursor':
        this.cursors?.setCursor(e.participantId, { file: e.path, line: e.line, character: e.character, displayName: e.label, color: e.color });
        this.patch({ where: { ...this.state.where, [e.participantId]: e.path } });
        break;
      default:
        break;
    }
  }

  private async promptJoin(requestId: string, who: string): Promise<void> {
    const pick = await vscode.window.showInformationMessage(`${who} wants to join your CodeMeet room.`, 'Accept', 'Decline');
    if (pick) await this.decideJoin(requestId, pick === 'Accept');
  }

  private async decideJoin(requestId: string, accept: boolean): Promise<void> {
    try {
      await this.session?.call('room.decide', { requestId, accept });
    } catch (e) {
      void vscode.window.showWarningMessage(`CodeMeet: ${(e as Error).message}`);
    }
  }

  // ── proposals ──

  private async onSidebarAction(a: SidebarAction): Promise<void> {
    if (a.kind === 'join') return this.decideJoin(a.id, a.accept);
    if (a.action === 'review') return this.reviewProposal(a.id);
    return this.decideProposal(a.id, a.action === 'approve');
  }

  async reviewProposal(id?: string): Promise<void> {
    const pid = id ?? (await this.pickProposal());
    if (!pid) return;
    const uri = vscode.Uri.parse(`codemeet-proposal:/${pid}.diff`);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'diff');
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private async pickProposal(onlyPending = false): Promise<string | undefined> {
    const items = [...this.proposals.values()].filter((p) => !onlyPending || p.status === 'pending');
    if (!items.length) return void vscode.window.showInformationMessage('No proposals yet.');
    return (await vscode.window.showQuickPick(items.map((p) => ({ label: p.title, description: `${p.agentLabel} - ${p.status}`, id: p.id })), { placeHolder: 'Pick a proposal' }))?.id;
  }

  async decideProposal(id: string | undefined, approve: boolean): Promise<void> {
    const pid = id ?? (await this.pickProposal(true));
    if (!pid || !this.session) return;
    const p = this.proposals.get(pid);
    if (approve) {
      const ok = await vscode.window.showWarningMessage(`Apply "${p?.title ?? pid}" by ${p?.agentLabel ?? 'an agent'} to the shared project for everyone?`, { modal: true, detail: p?.changes.map((c) => `${c.op} ${c.path}`).join('\n') }, 'Apply');
      if (!ok) return;
    }
    try {
      await this.session.call('proposal.decide', { proposalId: pid, approve });
    } catch (e) {
      void vscode.window.showWarningMessage(`CodeMeet: ${(e as Error).message}`);
    }
  }

  // ── agents and consent ──

  private async ensureAgent(provider: Provider): Promise<{ agentId: string; label: string }> {
    if (!this.session) throw new Error('Join or create a room first.');
    const r = await this.session.call('agent.register', { provider });
    this.agentIds[provider] = r.agentId;
    this.patch({ myAgents: { ...this.state.myAgents, [provider]: r.agentId } });
    return r;
  }

  private async pickProvider(): Promise<Provider | undefined> {
    const items: Array<{ label: string; provider: Provider; description: string }> = [];
    for (const p of ['claude', 'codex'] as const) {
      const info = await detectProvider(p);
      items.push({ label: p === 'claude' ? 'Claude' : 'Codex', provider: p, description: info.found ? (info.version ?? '') : 'not installed' });
    }
    return (await vscode.window.showQuickPick(items, { placeHolder: 'Which of your agents?' }))?.provider;
  }

  async runMyAgent(): Promise<void> {
    if (!this.session || !this.ws) return void vscode.window.showWarningMessage('Join or create a room first.');
    const provider = await this.pickProvider();
    if (!provider) return;
    const task = await vscode.window.showInputBox({ prompt: `What should your ${provider === 'claude' ? 'Claude' : 'Codex'} do? It works in an isolated copy; you review the result.` });
    if (!task?.trim()) return;
    const session = this.session;
    const root = this.ws.root;
    const host: AgentHost = {
      projectRoot: root,
      runsDir: path.join(this.ctx.globalStorageUri.fsPath, 'agents'),
      room: async () => {
        if (this.state.phase !== 'syncing' || !session.snapshot) throw new Error('The session is not connected right now.');
        return session.snapshot.room;
      },
      ensureAgent: (p) => this.ensureAgent(p),
      call: (op, input) => session.call(op, input),
    };
    mkdirSync(host.runsDir, { recursive: true });
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Your ${provider} is working...`, cancellable: true }, async (_p, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const r = await runAgent(host, { provider, task, timeoutMs: 15 * 60_000, allowShell: false, signal: abort.signal, log: (l) => this.out.appendLine(`[${provider}] ${l}`) });
        if (r.proposal) void vscode.window.showInformationMessage(`Proposal ready: ${r.proposal.title}`, 'Review').then((c) => c && void this.reviewProposal(r.proposal!.id));
        else void vscode.window.showInformationMessage('The agent finished without changing any shared file.');
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`CodeMeet: ${(e as Error).message}`);
    }
  }

  async grantPermission(): Promise<void> {
    if (!this.session) return void vscode.window.showWarningMessage('Join or create a room first.');
    const provider = await this.pickProvider();
    if (!provider) return;
    const mine = await this.ensureAgent(provider);
    const perm = await vscode.window.showQuickPick(
      [
        { label: 'Publish proposals', value: 'publish_proposals' as const, description: 'Let this agent post reviewable diffs to the room' },
        { label: 'Message another agent', value: 'agent_message' as const, description: 'Needs the other owner to grant the matching permission' },
        { label: 'Let it answer with my AI account', value: 'invoke_provider' as const, description: 'Runs your local provider CLI to reply to that agent' },
      ],
      { placeHolder: 'What are you allowing?' },
    );
    if (!perm) return;
    let peer: Participant | undefined;
    if (perm.value !== 'publish_proposals') {
      const agents = this.state.participants.filter((p) => p.kind === 'agent' && p.id !== mine.agentId);
      if (!agents.length) return void vscode.window.showInformationMessage('No other agents in the room yet. They appear once their owner registers them.');
      peer = (await vscode.window.showQuickPick(agents.map((a) => ({ label: a.label, a })), { placeHolder: 'With which agent?' }))?.a;
      if (!peer) return;
    }
    const minutes = Number(await vscode.window.showInputBox({ prompt: 'How many minutes should this last?', value: '60', validateInput: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 1440 ? null : '1 to 1440') }));
    if (!minutes) return;
    let auto = false;
    if (perm.value === 'invoke_provider') {
      const mode = await vscode.window.showQuickPick(['Review each message before my agent replies', 'Answer automatically (bounded by max turns)'], { placeHolder: 'Reply mode' });
      if (!mode) return;
      auto = mode.startsWith('Answer');
    }
    try {
      await this.session.call('consent.grant', { permission: perm.value, agentId: mine.agentId, peerAgentId: peer?.id, ttlMinutes: minutes, params: { maxTurns: 6, ...(auto ? { auto: true } : {}) } });
      void vscode.window.showInformationMessage('Permission granted. You can revoke it any time from "Revoke permission".');
    } catch (e) {
      void vscode.window.showErrorMessage(`CodeMeet: ${(e as Error).message}`);
    }
  }

  async revokePermission(): Promise<void> {
    if (!this.session) return;
    const label = (id: string) => this.state.participants.find((p) => p.id === id)?.label ?? id;
    const live = this.state.grants.filter((g) => !g.revokedAt && g.expiresAt > Date.now() && g.grantorId === this.session?.snapshot?.me);
    if (!live.length) return void vscode.window.showInformationMessage('You have no active permissions.');
    const pick = await vscode.window.showQuickPick(live.map((g) => ({ label: `${label(g.agentId)}: ${g.permission}`, description: g.peerAgentId ? `with ${label(g.peerAgentId)}` : '', id: g.id })), { placeHolder: 'Revoke which permission?' });
    if (!pick) return;
    await this.session.call('consent.revoke', { grantId: pick.id }).catch((e: Error) => void vscode.window.showErrorMessage(`CodeMeet: ${e.message}`));
  }

  async responderMode(): Promise<void> {
    if (!this.responder) return void vscode.window.showWarningMessage('Join or create a room first.');
    const provider = await this.pickProvider();
    if (!provider) return;
    await this.ensureAgent(provider);
    const mode = await vscode.window.showQuickPick(['off', 'review', 'auto'], { placeHolder: 'When a permitted peer agent messages yours' });
    if (!mode) return;
    this.responder.configure({ provider, mode: mode as 'off' | 'review' | 'auto' });
  }

  async showMessages(): Promise<void> {
    if (!this.responder) return;
    const inbox = this.responder.inbox();
    const items = [
      ...inbox.map((i) => ({ label: `${i.message.fromLabel} -> ${i.message.toLabel}`, description: i.state, detail: i.message.body.slice(0, 200), id: i.message.id, pending: i.state === 'pending' })),
      ...this.state.messages.filter((m) => !inbox.some((i) => i.message.id === m.id)).map((m) => ({ label: `${m.fromLabel} -> ${m.toLabel}`, description: m.state, detail: m.body.slice(0, 200), id: m.id, pending: false })),
    ];
    if (!items.length) return void vscode.window.showInformationMessage('No agent messages.');
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Agent messages (permitted pairs only)' });
    if (!pick?.pending) return;
    const act = await vscode.window.showQuickPick(['Let my agent reply', 'Dismiss'], { placeHolder: 'This message is waiting for review' });
    if (act) await this.responder.act({ messageId: pick.id, action: act.startsWith('Let') ? 'approve' : 'dismiss' }).catch((e: Error) => void vscode.window.showErrorMessage(e.message));
  }

  async copyRoomId(): Promise<void> {
    if (this.state.roomId) await vscode.env.clipboard.writeText(this.state.roomId);
  }

  /** Shared notes are an ordinary shared Markdown file, so they use the same conflict-free sync. */
  async openSharedNotes(): Promise<void> {
    if (!this.ws || !this.sync) return void vscode.window.showWarningMessage('Join or create a room first.');
    const file = vscode.Uri.file(path.join(this.ws.root, 'CODEMEET_NOTES.md'));
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      await vscode.workspace.fs.writeFile(file, Buffer.from('# Shared notes\n\n'));
      await this.sync.localChanged('CODEMEET_NOTES.md');
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  }

  // ── test seam (exposed only when CODEMEET_E2E=1) ──

  e2e() {
    return {
      host: (o: Parameters<Controller['hostWith']>[0]) => this.hostWith(o),
      join: (o: Parameters<Controller['joinWith']>[0]) => this.joinWith(o),
      state: (): UiState => this.state,
      decideJoin: (id: string, accept: boolean) => this.decideJoin(id, accept),
      decideProposalRaw: async (id: string, approve: boolean) => {
        await this.session?.call('proposal.decide', { proposalId: id, approve });
      },
      closeRoom: async () => {
        this.closing = true;
        try {
          await this.session?.call('room.close', {});
          await this.teardown();
        } finally {
          this.closing = false;
        }
      },
      stop: () => this.teardown(),
      listenerCounts: () => ({ evt: this.session?.listenerCount('evt') ?? 0, state: this.session?.listenerCount('state') ?? 0, disposables: this.sessionDisposables.length }),
    };
  }

  // ── teardown ──

  /** Releases everything a session created. Safe to call repeatedly. */
  async teardown(keepFilesMessage = false): Promise<void> {
    void keepFilesMessage;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const d of this.sessionDisposables.splice(0)) d.dispose();
    this.cursors?.dispose();
    this.cursors = null;
    await this.responder?.stop().catch(() => undefined);
    this.responder = null;
    await this.sync?.flushState().catch(() => undefined);
    this.sync?.stop();
    this.sync = null;
    this.session?.dispose();
    this.session = null;
    if (this.ws) releaseLock(this.ws.root, process.pid);
    this.ws = null;
    this.proposals.clear();
    for (const k of Object.keys(this.agentIds)) delete this.agentIds[k as Provider];
    this.state = emptyState();
    this.publish();
  }

  dispose(): void {
    void this.teardown();
    this.status.dispose();
    this.sidebar.dispose();
    this.changeEmitter.dispose();
  }
}

/** Read-only virtual documents that render a proposal's diffs. */
export class ProposalDocs implements vscode.TextDocumentContentProvider {
  readonly onDidChange: vscode.Event<vscode.Uri>;
  constructor(private readonly proposals: Map<string, ProposalView>, changed: vscode.Event<string>) {
    const emitter = new vscode.EventEmitter<vscode.Uri>();
    changed((id) => emitter.fire(vscode.Uri.parse(`codemeet-proposal:/${id}.diff`)));
    this.onDidChange = emitter.event;
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = uri.path.replace(/^\//, '').replace(/\.diff$/, '');
    const p = this.proposals.get(id);
    if (!p) return 'Proposal not found.';
    const head = [`${p.agentLabel}: ${p.title}`, `status: ${p.status}   revision: ${p.revision}`, p.staleReason ? `WARNING: ${p.staleReason}` : '', ''];
    return head.join('\n') + p.changes.map((c) => `=== ${c.op} ${c.path}\n${c.diff}`).join('\n');
  }
}
