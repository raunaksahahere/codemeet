import * as path from 'node:path';
import * as vscode from 'vscode';
import fastDiff from 'fast-diff';
import { LIMITS } from '@codemeet/shared';
import type { ListResult, NodeWorkspace, ReadResult, Workspace } from '@codemeet/core';

/**
 * Workspace adapter for VS Code. For a file that is open in an editor the buffer is the source
 * of truth (it may hold unsaved edits); for everything else the file on disk is. This is what
 * prevents unsaved buffers and disk changes from being emitted twice or overwriting each other.
 */
export class VsCodeWorkspace implements Workspace {
  constructor(
    private readonly inner: NodeWorkspace,
    readonly root: string,
  ) {}

  list(): Promise<ListResult> {
    return this.inner.list();
  }

  /** The open, live editor document for a shared path, if any. */
  openDocument(rel: string): vscode.TextDocument | undefined {
    const abs = path.join(this.root, ...rel.split('/'));
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && !d.isClosed && d.uri.fsPath === abs);
  }

  async read(rel: string): Promise<ReadResult> {
    const doc = this.openDocument(rel);
    if (doc) {
      // Validate the path (traversal, symlinks, policy) exactly like a disk read would.
      await this.inner.resolve(rel, { allowMissing: true });
      const text = doc.getText();
      if (Buffer.byteLength(text, 'utf8') > LIMITS.maxFileBytes) return { kind: 'skipped', reason: `larger than ${LIMITS.maxFileBytes} bytes` };
      return { kind: 'text', text };
    }
    return this.inner.read(rel);
  }

  async write(rel: string, text: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = this.openDocument(rel);
      if (!doc) return this.inner.write(rel, text);
      await this.inner.resolve(rel, { allowMissing: true });
      const current = doc.getText();
      if (current === text) return;
      const version = doc.version;
      const edit = new vscode.WorkspaceEdit();
      let offset = 0;
      // fast-diff operates on the original text, so every offset is relative to `current`.
      for (const [op, chunk] of fastDiff(current, text)) {
        if (op === fastDiff.EQUAL) offset += chunk.length;
        else if (op === fastDiff.DELETE) {
          edit.delete(doc.uri, new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + chunk.length)));
          offset += chunk.length;
        } else edit.insert(doc.uri, doc.positionAt(offset), chunk);
      }
      if (doc.version === version && (await vscode.workspace.applyEdit(edit))) return;
      // The user typed while we computed the diff; recompute against the new buffer.
    }
    throw new Error(`Could not apply a remote change to the open editor for ${rel}; it will be retried on the next update.`);
  }

  trash(rel: string): Promise<void> {
    return this.inner.trash(rel);
  }
  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }
  backup(rel: string, text: string, stamp: string): Promise<string> {
    return this.inner.backup(rel, text, stamp);
  }
}
