import { describe, expect, it } from 'vitest';
import { buildArgs, childEnv, parseEvent } from './providers.js';

describe('provider event parsing (fixtures, not a live provider test)', () => {
  it('claude: final result, tool use and assistant text', () => {
    expect(parseEvent('claude', { type: 'result', result: 'done', total_cost_usd: 0.02, is_error: false })).toMatchObject({ text: 'done', final: true, cost: 0.02 });
    expect(parseEvent('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }] } }).summary).toBe('claude uses Edit on a.ts');
    expect(parseEvent('claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual({ text: 'hi' });
    expect(parseEvent('claude', { type: 'system', subtype: 'init' })).toEqual({});
  });
  it('codex: agent message, commands, file changes; unknown events are ignored', () => {
    expect(parseEvent('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })).toMatchObject({ text: 'ok', final: true });
    expect(parseEvent('codex', { type: 'item.completed', item: { type: 'command_execution', command: 'ls -la' } }).summary).toContain('ls -la');
    expect(parseEvent('codex', { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'x' }] } }).summary).toContain('x');
    expect(parseEvent('codex', { type: 'something.new' })).toEqual({});
  });
});

describe('provider invocation arguments', () => {
  it('claude edit runs restricted with accept-edits only', () => {
    const a = buildArgs({ provider: 'claude', mode: 'edit', prompt: 'p' });
    expect(a).toEqual(expect.arrayContaining(['-p', 'p', '--output-format', 'stream-json', '--restricted', '--permission-mode', 'acceptEdits', '--no-session-persistence']));
    expect(a).not.toContain('bypassPermissions');
    expect(a).not.toContain('--dangerously-skip-permissions');
  });
  it('claude chat disables every tool', () => {
    const a = buildArgs({ provider: 'claude', mode: 'chat', prompt: 'p', maxBudgetUsd: 0.5 });
    expect(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(a).toEqual(expect.arrayContaining(['--max-budget-usd', '0.5']));
  });
  it('codex edit uses the workspace-write sandbox; chat is read-only; never bypasses the sandbox', () => {
    const e = buildArgs({ provider: 'codex', mode: 'edit', prompt: 'p' }, '/tmp/last');
    expect(e).toEqual(expect.arrayContaining(['exec', '--json', '-s', 'workspace-write', '-o', '/tmp/last']));
    expect(buildArgs({ provider: 'codex', mode: 'chat', prompt: 'p' })).toEqual(expect.arrayContaining(['-s', 'read-only']));
    expect(e.join(' ')).not.toContain('dangerously');
  });
  it('child processes never inherit the database credentials', () => {
    process.env.DATABASE_URL = 'postgresql://u:secret@h/db';
    expect(childEnv({ CODEMEET_AGENT: 'claude' }).DATABASE_URL).toBeUndefined();
    expect(childEnv({ CODEMEET_AGENT: 'claude' }).CODEMEET_AGENT).toBe('claude');
    delete process.env.DATABASE_URL;
  });
});
