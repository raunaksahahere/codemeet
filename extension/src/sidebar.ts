import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { UiState } from './uiState';

/** Commands the webview may trigger; anything else in a message is ignored. */
const COMMANDS = new Set([
  'codemeet.createRoom', 'codemeet.joinRoom', 'codemeet.leaveRoom', 'codemeet.runAgent', 'codemeet.grantPermission',
  'codemeet.revokePermission', 'codemeet.copyRoomId', 'codemeet.openSharedNotes', 'codemeet.openPrivateNotes',
  'codemeet.responderMode', 'codemeet.showMessages',
]);

export type SidebarAction =
  | { kind: 'proposal'; id: string; action: 'review' | 'approve' | 'reject' }
  | { kind: 'join'; id: string; accept: boolean };

/**
 * Sidebar webview. Every peer-controlled string (names, paths, titles, messages) is rendered with
 * textContent in the page, never concatenated into HTML, and the page runs under a nonce-based CSP.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private last: UiState | null = null;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly onAction: (a: SidebarAction) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    this.subs.push(
      view.webview.onDidReceiveMessage((msg: unknown) => this.onMessage(msg)),
      view.onDidDispose(() => (this.view = null)),
    );
    if (this.last) void view.webview.postMessage({ type: 'state', state: this.last });
  }

  update(state: UiState): void {
    this.last = state;
    void this.view?.webview.postMessage({ type: 'state', state });
  }

  private onMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;
    const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
    if (m.type === 'command' && str(m.command) && COMMANDS.has(m.command)) {
      void vscode.commands.executeCommand(m.command);
    } else if (m.type === 'proposal' && str(m.id) && (m.action === 'review' || m.action === 'approve' || m.action === 'reject')) {
      this.onAction({ kind: 'proposal', id: m.id, action: m.action });
    } else if (m.type === 'join' && str(m.id) && typeof m.accept === 'boolean') {
      this.onAction({ kind: 'join', id: m.id, accept: m.accept });
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CodeMeet</title>
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px;font-size:12px}
h3{margin:14px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 8px;margin:2px 4px 2px 0;cursor:pointer;border-radius:2px}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.row{display:flex;align-items:center;gap:6px;margin:3px 0;flex-wrap:wrap}.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.muted{opacity:.65}.card{border:1px solid var(--vscode-widget-border,#555);padding:6px;margin:6px 0;border-radius:3px}
.tag{font-size:10px;padding:0 4px;border-radius:2px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
</style></head><body><div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
function el(tag, props, ...kids){const e=document.createElement(tag);if(props)for(const[k,v]of Object.entries(props)){if(k==='class')e.className=v;else if(k==='style')e.setAttribute('style',v);else if(k==='onclick')e.addEventListener('click',v);else e.setAttribute(k,String(v));}
for(const kid of kids){if(kid==null)continue;e.append(typeof kid==='string'?document.createTextNode(kid):kid);}return e;}
const cmd=(command)=>()=>vscode.postMessage({type:'command',command});
const safeColor=(c)=>/^#[0-9a-fA-F]{3,8}$/.test(c)?c:'#888';
function render(s){
  root.replaceChildren();
  if(s.phase==='idle'){
    root.append(el('div',{class:'muted'},'Not in a room.'),
      el('button',{onclick:cmd('codemeet.createRoom')},'Create room'),el('button',{class:'secondary',onclick:cmd('codemeet.joinRoom')},'Join room'),
      el('button',{class:'secondary',onclick:cmd('codemeet.openPrivateNotes')},'Private notes'));
    return;
  }
  root.append(el('h3',null,'Room'),el('div',null,s.roomId+' ('+(s.role||'')+')'),el('div',{class:'muted'},s.phase+(s.detail?' - '+s.detail:'')),
    el('div',{class:'row'},el('button',{class:'secondary',onclick:cmd('codemeet.copyRoomId')},'Copy ID'),el('button',{class:'secondary',onclick:cmd('codemeet.leaveRoom')},'Leave')));
  if(s.pending.length){root.append(el('h3',null,'Join requests'));
    for(const p of s.pending)root.append(el('div',{class:'card'},el('div',null,p.displayName+' wants to join'),
      el('button',{onclick:()=>vscode.postMessage({type:'join',id:p.id,accept:true})},'Accept'),el('button',{class:'secondary',onclick:()=>vscode.postMessage({type:'join',id:p.id,accept:false})},'Decline')));}
  root.append(el('h3',null,'People and agents'));
  for(const p of s.participants){root.append(el('div',{class:'row'},el('span',{class:'dot',style:'background:'+safeColor(p.color)+';opacity:'+(p.online?1:.3)}),el('span',null,p.label),
    p.kind==='agent'?el('span',{class:'tag'},'agent'):null,s.where[p.id]?el('span',{class:'muted'},s.where[p.id]):null));}
  root.append(el('div',{class:'row'},el('button',{onclick:cmd('codemeet.runAgent')},'Run my agent'),el('button',{class:'secondary',onclick:cmd('codemeet.grantPermission')},'Permissions'),el('button',{class:'secondary',onclick:cmd('codemeet.responderMode')},'Responder')));
  const open=s.proposals.filter(p=>p.status==='pending');
  root.append(el('h3',null,'Proposals ('+open.length+' pending)'));
  for(const p of s.proposals.slice(0,8)){const c=el('div',{class:'card'},el('div',null,p.agentLabel+': '+p.title),el('div',{class:'muted'},p.status+' - '+p.changes.length+' file(s)'+(p.staleReason?' - STALE':'')));
    c.append(el('button',{class:'secondary',onclick:()=>vscode.postMessage({type:'proposal',id:p.id,action:'review'})},'Review'));
    if(p.status==='pending'){c.append(el('button',{onclick:()=>vscode.postMessage({type:'proposal',id:p.id,action:'approve'})},'Approve'),el('button',{class:'secondary',onclick:()=>vscode.postMessage({type:'proposal',id:p.id,action:'reject'})},'Reject'));}
    root.append(c);}
  const live=s.grants.filter(g=>!g.revokedAt&&g.expiresAt>Date.now());
  root.append(el('h3',null,'Permissions ('+live.length+' active)'),el('div',{class:'muted'},live.length?'Agent messaging is on only for the pairs listed in "Permissions".':'Agent-to-agent messaging is off.'));
  root.append(el('h3',null,'Activity'));
  for(const a of s.activity.slice(-10).reverse())root.append(el('div',{class:'muted'},new Date(a.at).toLocaleTimeString()+'  '+a.summary));
  root.append(el('div',{class:'row'},el('button',{class:'secondary',onclick:cmd('codemeet.openSharedNotes')},'Shared notes'),el('button',{class:'secondary',onclick:cmd('codemeet.openPrivateNotes')},'Private notes'),el('button',{class:'secondary',onclick:cmd('codemeet.showMessages')},'Agent messages')));
}
window.addEventListener('message',e=>{const m=e.data;if(m&&m.type==='state'&&m.state)render(m.state);});
render({phase:'idle'});
</script></body></html>`;
  }
}
