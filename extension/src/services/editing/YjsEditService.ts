import * as Y from 'yjs';
import * as vscode from 'vscode';
import type {
  YjsUpdatePayload,
  YjsSyncRequestPayload,
  YjsSyncResponsePayload,
} from '@codemeet/shared';
import type { TypedSocket } from '../ConnectionManager.js';

/**
 * CRDT-based edit sync using Yjs.
 *
 * Each open file gets its own Y.Doc with a Y.Text.
 * Local edits → Y.Doc mutation → binary update broadcast.
 * Remote updates → Y.Doc merge → VS Code workspace edit.
 *
 * Replaces the OT-lite EditSyncService with conflict-free merging.
 */
export class YjsEditService implements vscode.Disposable {
  private docs = new Map<string, Y.Doc>();
  private socket: TypedSocket | null = null;
  private roomId: string | null = null;
  private isHost = false;
  private disposables: vscode.Disposable[] = [];

  /** Files currently being updated from remote — suppress re-broadcast. */
  private suppressedFiles = new Set<string>();

  constructor() {}

  start(socket: TypedSocket, roomId: string, isHost: boolean): void {
    this.socket = socket;
    this.roomId = roomId;
    this.isHost = isHost;

    // Listen for local document changes
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.onLocalChange(e);
      }),
    );

    // Listen for remote Yjs updates
    socket.on('yjs-update', (data: YjsUpdatePayload) => {
      if (data.roomId === this.roomId) {
        this.applyRemoteUpdate(data.file, new Uint8Array(data.update));
      }
    });

    // Host: respond to sync requests from guests
    if (isHost) {
      socket.on('yjs-sync-request', (data: YjsSyncRequestPayload) => {
        if (data.roomId === this.roomId) {
          this.handleSyncRequest(data);
        }
      });
    }

    // Guest: receive sync responses from host
    if (!isHost) {
      socket.on('yjs-sync-response', (data: YjsSyncResponsePayload) => {
        if (data.roomId === this.roomId && data.targetId === socket.id) {
          this.handleSyncResponse(data);
        }
      });
    }

    // Initialize Y.Docs for currently open editors
    for (const editor of vscode.window.visibleTextEditors) {
      const filePath = this.getRelativePath(editor.document.uri);
      if (filePath) {
        this.getOrCreateDoc(filePath, editor.document.getText());
      }
    }

    // Track newly opened editors
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) return;
        const filePath = this.getRelativePath(editor.document.uri);
        if (!filePath) return;

        const doc = this.getOrCreateDoc(filePath, editor.document.getText());

        // Guest: request full sync for newly opened files
        if (!this.isHost && this.socket && this.roomId) {
          this.socket.emit('yjs-sync-request', {
            roomId: this.roomId,
            file: filePath,
            requesterId: this.socket.id ?? '',
          });
        }

        void doc; // used for side-effect
      }),
    );

    console.log(`[CodeMeet] Yjs CRDT sync started (${isHost ? 'host' : 'guest'})`);
  }

  stop(): void {
    // Destroy all Y.Docs
    for (const doc of this.docs.values()) {
      doc.destroy();
    }
    this.docs.clear();
    this.socket = null;
    this.roomId = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  private getOrCreateDoc(filePath: string, initialContent?: string): Y.Doc {
    let doc = this.docs.get(filePath);
    if (doc) return doc;

    doc = new Y.Doc();
    this.docs.set(filePath, doc);

    // Initialize Y.Text with current file content
    const ytext = doc.getText('content');
    if (initialContent && ytext.length === 0) {
      doc.transact(() => {
        ytext.insert(0, initialContent);
      }, this); // origin = this → we'll check origin to skip self-broadcasts
    }

    // Observe Y.Text changes from remote peers
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Only broadcast updates that originated locally (not from remote apply)
      if (origin === this && this.socket && this.roomId) {
        this.socket.emit('yjs-update', {
          roomId: this.roomId,
          file: filePath,
          update: Array.from(update),
        });
      }
    });

    return doc;
  }

  private onLocalChange(event: vscode.TextDocumentChangeEvent): void {
    const doc = event.document;
    if (doc.uri.scheme !== 'file') return;
    if (event.contentChanges.length === 0) return;

    const filePath = this.getRelativePath(doc.uri);
    if (!filePath) return;
    if (this.suppressedFiles.has(filePath)) return;

    const ydoc = this.getOrCreateDoc(filePath);
    const ytext = ydoc.getText('content');

    // Apply VS Code changes to Y.Text
    ydoc.transact(() => {
      // Process changes in reverse order to maintain position integrity
      const sorted = [...event.contentChanges].sort(
        (a, b) => b.rangeOffset - a.rangeOffset,
      );

      for (const change of sorted) {
        if (change.rangeLength > 0) {
          ytext.delete(change.rangeOffset, change.rangeLength);
        }
        if (change.text.length > 0) {
          ytext.insert(change.rangeOffset, change.text);
        }
      }
    }, this); // origin = this → triggers broadcast in the 'update' handler
  }

  private async applyRemoteUpdate(file: string, update: Uint8Array): Promise<void> {
    const ydoc = this.getOrCreateDoc(file);
    const ytext = ydoc.getText('content');

    // Get content before applying
    const beforeContent = ytext.toString();

    // Apply the remote Yjs update (origin = 'remote' so we don't re-broadcast)
    Y.applyUpdate(ydoc, update, 'remote');

    const afterContent = ytext.toString();

    // If content changed, apply the diff to VS Code
    if (beforeContent !== afterContent) {
      await this.applyToEditor(file, afterContent);
    }
  }

  private async applyToEditor(file: string, newContent: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, file);

    // Find the open document
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === fileUri.toString(),
    );
    if (!openDoc) return;

    // Replace entire content (Yjs handles the merge, we trust its output)
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      openDoc.lineAt(openDoc.lineCount - 1).range.end,
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(fileUri, fullRange, newContent);

    this.suppressedFiles.add(file);
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      setTimeout(() => this.suppressedFiles.delete(file), 100);
    }
  }

  private handleSyncRequest(data: YjsSyncRequestPayload): void {
    const ydoc = this.docs.get(data.file);
    if (!ydoc || !this.socket || !this.roomId) return;

    // Send full document state to the requester
    const state = Y.encodeStateAsUpdate(ydoc);
    this.socket.emit('yjs-sync-response', {
      roomId: this.roomId,
      file: data.file,
      state: Array.from(state),
      targetId: data.requesterId,
    });

    console.log(`[CodeMeet] Sent Yjs sync for ${data.file} to ${data.requesterId}`);
  }

  private handleSyncResponse(data: YjsSyncResponsePayload): void {
    const ydoc = this.getOrCreateDoc(data.file);

    // Apply the full state from host
    Y.applyUpdate(ydoc, new Uint8Array(data.state), 'remote');

    // Update the editor with the synced content
    const ytext = ydoc.getText('content');
    void this.applyToEditor(data.file, ytext.toString());

    console.log(`[CodeMeet] Received Yjs sync for ${data.file}`);
  }

  private getRelativePath(uri: vscode.Uri): string | null {
    if (uri.scheme !== 'file') return null;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) return null;
    return vscode.workspace.asRelativePath(uri, false);
  }

  dispose(): void {
    this.stop();
  }
}
