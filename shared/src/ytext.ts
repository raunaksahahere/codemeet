import * as Y from 'yjs';
import fastDiff from 'fast-diff';

/**
 * Rewrites `ytext` so that it equals `next`, touching only the characters that
 * actually changed. Fine-grained operations keep concurrent edits from other peers
 * intact instead of replacing the whole document.
 */
export function applyTextDiff(ytext: Y.Text, next: string): boolean {
  const current = ytext.toString();
  if (current === next) return false;
  const ydoc = ytext.doc;
  const run = () => {
    let index = 0;
    for (const [op, text] of fastDiff(current, next)) {
      if (op === fastDiff.EQUAL) index += text.length;
      else if (op === fastDiff.DELETE) ytext.delete(index, text.length);
      else {
        ytext.insert(index, text);
        index += text.length;
      }
    }
  };
  if (ydoc) ydoc.transact(run, LOCAL_ORIGIN);
  else run();
  return true;
}

/** Transaction origin used for edits that originate on this machine. */
export const LOCAL_ORIGIN = Symbol('codemeet-local');
