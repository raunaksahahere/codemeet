import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Provider } from '@codemeet/shared';

const execFileP = promisify(execFile);

export interface ProviderInfo {
  provider: Provider;
  binary: string;
  found: boolean;
  version?: string;
  hint: string;
}

const INSTALL_HINT: Record<Provider, string> = {
  claude: 'Install Claude Code (https://docs.claude.com/en/docs/claude-code) and run `claude` once to sign in.',
  codex: 'Install the Codex CLI (https://github.com/openai/codex) and run `codex login`.',
};

export function binaryFor(provider: Provider): string {
  return process.env[`CODEMEET_${provider.toUpperCase()}_BIN`] || provider;
}

export async function detectProvider(provider: Provider): Promise<ProviderInfo> {
  const binary = binaryFor(provider);
  try {
    const { stdout } = await execFileP(binary, ['--version'], { timeout: 15_000 });
    return { provider, binary, found: true, version: stdout.trim().split('\n')[0], hint: INSTALL_HINT[provider] };
  } catch {
    return { provider, binary, found: false, hint: INSTALL_HINT[provider] };
  }
}

export async function requireProvider(provider: Provider): Promise<ProviderInfo> {
  const info = await detectProvider(provider);
  if (!info.found) throw new Error(`The \`${info.binary}\` executable was not found or does not run. ${info.hint} (Human collaboration works without it.)`);
  return info;
}

/** Environment for provider child processes: everything the user has, minus CodeMeet's own secrets. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const k of ['DATABASE_URL', 'CODEMEET_ROOM_PASSWORD', 'CODEMEET_DB_SSL']) delete env[k];
  return env;
}

export interface RunOptions {
  provider: Provider;
  cwd: string;
  prompt: string;
  /** "edit" lets the agent change files inside cwd; "chat" gives it no tools at all. */
  mode: 'edit' | 'chat';
  timeoutMs: number;
  signal?: AbortSignal;
  maxBudgetUsd?: number;
  allowShell?: boolean;
  env?: Record<string, string>;
  onText?: (text: string) => void;
  onEvent?: (summary: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  finalText: string;
  timedOut: boolean;
  aborted: boolean;
  costUsd?: number;
  stderrTail: string;
}

/** Builds the argv for a provider invocation using only documented non-interactive flags. */
export function buildArgs(o: Pick<RunOptions, 'provider' | 'mode' | 'prompt' | 'maxBudgetUsd' | 'allowShell'>, lastMessageFile?: string): string[] {
  if (o.provider === 'claude') {
    const common = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    if (o.maxBudgetUsd) common.push('--max-budget-usd', String(o.maxBudgetUsd));
    if (o.mode === 'chat') return [...common, '--tools', ''];
    // --restricted removes command-running tools and confines file tools to the working directory.
    return [...common, '--restricted', '--permission-mode', 'acceptEdits'];
  }
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral'];
  if (o.mode === 'chat') args.push('-s', 'read-only');
  else args.push('-s', 'workspace-write');
  if (lastMessageFile) args.push('-o', lastMessageFile);
  args.push(o.prompt);
  return args;
}

/** Runs a provider CLI and parses its structured event stream. */
export async function runProvider(o: RunOptions): Promise<RunResult> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'codemeet-run-'));
  const lastFile = path.join(outDir, 'last-message.txt');
  const args = buildArgs(o, lastFile);
  const child = spawn(binaryFor(o.provider), args, {
    cwd: o.cwd,
    env: childEnv(o.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timedOut = false;
  let aborted = false;
  const kill = () => {
    if (!child.killed) child.kill('SIGTERM');
    setTimeout(() => !child.killed || child.exitCode === null ? child.kill('SIGKILL') : undefined, 3000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, o.timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (o.signal?.aborted) onAbort();
  o.signal?.addEventListener('abort', onAbort);

  let finalText = '';
  let costUsd: number | undefined;
  let stderr = '';
  let buf = '';
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise is ignored, never executed
    }
    const parsed = parseEvent(o.provider, ev);
    if (parsed.text) {
      finalText = parsed.final ? parsed.text : finalText || parsed.text;
      o.onText?.(parsed.text);
    }
    if (parsed.final && parsed.text) finalText = parsed.text;
    if (parsed.cost !== undefined) costUsd = parsed.cost;
    if (parsed.summary) o.onEvent?.(parsed.summary);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    stderr = (stderr + c).slice(-2000);
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      stderr += String(e);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  o.signal?.removeEventListener('abort', onAbort);
  handleLine(buf);
  if (o.provider === 'codex') {
    try {
      const last = readFileSync(lastFile, 'utf8').trim();
      if (last) finalText = last;
    } catch {
      /* no final message file */
    }
  }
  rmSync(outDir, { recursive: true, force: true });
  return { exitCode, finalText: finalText.trim(), timedOut, aborted, costUsd, stderrTail: stderr.trim() };
}

interface Parsed {
  text?: string;
  final?: boolean;
  cost?: number;
  summary?: string;
}

/** Extracts what we need from documented structured events; unknown event shapes are ignored. */
export function parseEvent(provider: Provider, ev: Record<string, unknown>): Parsed {
  if (provider === 'claude') {
    const type = ev.type;
    if (type === 'result') {
      return {
        text: typeof ev.result === 'string' ? ev.result : undefined,
        final: true,
        cost: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
        summary: ev.is_error ? 'claude finished with an error' : 'claude finished',
      };
    }
    if (type === 'assistant') {
      const content = ((ev.message as { content?: unknown[] } | undefined)?.content ?? []) as Array<{ type?: string; text?: string; name?: string; input?: { file_path?: string } }>;
      const tool = content.find((c) => c.type === 'tool_use');
      if (tool) return { summary: `claude uses ${tool.name}${tool.input?.file_path ? ` on ${tool.input.file_path}` : ''}` };
      const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      return text ? { text } : {};
    }
    return {};
  }
  // codex: JSONL "ThreadEvent"s
  const item = (ev.item ?? {}) as { type?: string; text?: string; command?: string; changes?: Array<{ path?: string }> };
  if (ev.type === 'item.completed') {
    if (item.type === 'agent_message' && item.text) return { text: item.text, final: true, summary: 'codex replied' };
    if (item.type === 'command_execution') return { summary: `codex ran: ${String(item.command ?? '').slice(0, 80)}` };
    if (item.type === 'file_change') return { summary: `codex changed ${(item.changes ?? []).map((c) => c.path).join(', ')}` };
  }
  if (ev.type === 'turn.completed') return { summary: 'codex turn completed' };
  return {};
}
