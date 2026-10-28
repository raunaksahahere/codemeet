#!/usr/bin/env node
// Deterministic stand-in for the `claude` and `codex` CLIs. FIXTURE ONLY: it is used to test
// parsers, cancellation and failure paths and is never presented as a live provider test.
//   FAKE_EDIT="path::content"   file the "agent" writes in edit mode (cwd)
//   FAKE_REPLY="text"           reply in chat mode (default STUB-REPLY)
//   FAKE_SLEEP_MS=n             delay before replying in chat mode
//   FAKE_MARKER=/path           file appended to when the provider is invoked / finishes
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const kind = process.env.FAKE_KIND || (argv[0] === 'exec' ? 'codex' : 'claude');
const marker = process.env.FAKE_MARKER;
const note = (s) => marker && appendFileSync(marker, s + '\n');
if (argv.includes('--version')) {
  console.log(kind === 'codex' ? 'codex-cli 0.0.0-fixture' : '0.0.0-fixture (Claude Code)');
  process.exit(0);
}
const chat = kind === 'codex' ? argv.includes('read-only') : argv.includes('--tools');
note(`invoked:${chat ? 'chat' : 'edit'}`);
const out = (o) => console.log(JSON.stringify(o));

if (!chat && process.env.FAKE_EDIT) {
  for (const spec of process.env.FAKE_EDIT.split('|')) {
    const [rel, ...rest] = spec.split('::');
    const content = rest.join('::');
    if (content === '__DELETE__') await import('node:fs').then((fs) => fs.rmSync(rel, { force: true }));
    else {
      mkdirSync(path.dirname(path.resolve(rel)), { recursive: true });
      writeFileSync(rel, content);
    }
  }
}
const sleep = Number(process.env.FAKE_SLEEP_MS || 0);
if (sleep) await new Promise((r) => setTimeout(r, sleep));
const text = chat ? process.env.FAKE_REPLY || 'STUB-REPLY' : 'Edited as requested.';
if (kind === 'claude') {
  out({ type: 'system', subtype: 'init' });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x' } }] } });
  out({ type: 'result', subtype: 'success', result: text, total_cost_usd: 0.001, is_error: false });
} else {
  out({ type: 'thread.started' });
  out({ type: 'item.completed', item: { type: 'agent_message', text } });
  out({ type: 'turn.completed' });
  const o = argv.indexOf('-o');
  if (o >= 0) writeFileSync(argv[o + 1], text);
}
note('finished');
