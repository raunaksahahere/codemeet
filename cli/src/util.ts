import { spawn } from 'node:child_process';
import { closeSync, openSync, realpathSync } from 'node:fs';
import * as readline from 'node:readline';
import { files, CliError } from './home.js';
import { IpcClient, readDaemonInfo } from './ipc.js';

export const VERSION = '0.1.0';

/** Reads a secret from the terminal without echoing it. */
export async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new CliError(`${question.replace(/:\s*$/, '')} is required; provide it through an environment variable or run in a terminal.`);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const w = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stderr.write(question);
    w._writeToOutput = () => undefined; // suppress echo of typed characters
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

export async function promptLine(question: string, def?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (def !== undefined) return def;
    throw new CliError(`${question.replace(/:\s*$/, '')} is required (use the corresponding option when not in a terminal).`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(def ? `${question} [${def}]: ` : `${question}: `, (a) => {
      rl.close();
      resolve(a.trim() || def || '');
    }),
  );
}

export async function resolveSecret(envVar: string, question: string): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return promptSecret(question);
}

/** Starts the detached session daemon and waits until it reports a settled phase. */
export async function startDaemonProcess(): Promise<IpcClient> {
  if (readDaemonInfo()) throw new CliError('A CodeMeet session is already active. Run `codemeet status` or `codemeet leave`.');
  const script = realpathSync(process.argv[1] as string);
  const out = openSync(files.daemonLog(), 'a', 0o600);
  const child = spawn(process.execPath, [script, 'daemon'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  closeSync(out);
  const deadline = Date.now() + 90_000;
  let client: IpcClient | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const info = readDaemonInfo();
    if (!info) {
      if (child.exitCode !== null) throw new CliError(`The session daemon exited early (code ${child.exitCode}). See ${files.daemonLog()}`);
      continue;
    }
    try {
      client ??= await IpcClient.connect(info);
      const st = await client.call<{ phase: string }>('status', undefined, 5000);
      if (!['starting', 'bootstrapping'].includes(st.phase)) return client;
    } catch {
      client?.close();
      client = null;
    }
  }
  throw new CliError(`Timed out waiting for the session daemon. See ${files.daemonLog()}`);
}

export function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function expandPermission(name: string): 'publish_proposals' | 'apply_code' | 'agent_message' | 'invoke_provider' {
  const map: Record<string, 'publish_proposals' | 'apply_code' | 'agent_message' | 'invoke_provider'> = {
    publish: 'publish_proposals', publish_proposals: 'publish_proposals',
    apply: 'apply_code', apply_code: 'apply_code',
    message: 'agent_message', agent_message: 'agent_message', messaging: 'agent_message',
    invoke: 'invoke_provider', invoke_provider: 'invoke_provider',
  };
  const v = map[name];
  if (!v) throw new CliError(`Unknown permission "${name}". Use: publish, apply, message, invoke`);
  return v;
}
