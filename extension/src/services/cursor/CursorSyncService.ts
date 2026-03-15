import * as vscode from 'vscode';
import type { CursorUpdateRelayPayload } from '@codemeet/shared';
import type { TypedSocket } from '../ConnectionManager.js';
import { CursorDecorationManager } from './CursorDecorationManager.js';

const THROTTLE_MS = 50;

/**
 * Syncs cursor positions between peers.
 * Listens on onDidChangeTextEditorSelection (throttled to 50ms).
 * Sends cursor updates via Socket.IO relay; renders remote cursors with decorations.
 */
export class CursorSyncService implements vscode.Disposable {
  private decorationManager = new CursorDecorationManager();
  private socket: TypedSocket | null = null;
  private roomId: string | null = null;
  private userId: string;
  private displayName: string;
  private color: string;
  private disposables: vscode.Disposable[] = [];
  private lastSend = 0;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(userId: string, displayName: string, color: string) {
    this.userId = userId;
    this.displayName = displayName;
    this.color = color;

    // Track cursor changes
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.handleLocalCursorChange(e);
      }),
    );
  }

  start(socket: TypedSocket, roomId: string): void {
    this.socket = socket;
    this.roomId = roomId;

    // Listen for incoming remote cursor updates
    socket.on('cursor-update', (data: CursorUpdateRelayPayload) => {
      if (data.roomId === this.roomId && data.cursor.userId !== this.userId) {
        this.decorationManager.setCursor(data.cursor.userId, {
          file: data.cursor.file,
          line: data.cursor.line,
          character: data.cursor.character,
          displayName: data.cursor.displayName,
          color: data.cursor.color,
        });
      }
    });
  }

  stop(): void {
    this.socket = null;
    this.roomId = null;
    this.decorationManager.clearAll();
  }

  /** Remove a specific peer's cursor (e.g. on user-left). */
  removePeer(userId: string): void {
    this.decorationManager.removeCursor(userId);
  }

  private handleLocalCursorChange(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.socket || !this.roomId) return;

    const editor = event.textEditor;
    if (editor.document.uri.scheme !== 'file') return;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!workspaceFolder) return;

    const now = Date.now();
    const elapsed = now - this.lastSend;

    if (elapsed < THROTTLE_MS) {
      // Throttle: schedule a send after the remaining time
      if (this.throttleTimer) clearTimeout(this.throttleTimer);
      this.throttleTimer = setTimeout(() => {
        this.sendCursorUpdate(editor);
      }, THROTTLE_MS - elapsed);
      return;
    }

    this.sendCursorUpdate(editor);
  }

  private sendCursorUpdate(editor: vscode.TextEditor): void {
    if (!this.socket || !this.roomId) return;

    const selection = editor.selection;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

    this.socket.emit('cursor-update', {
      roomId: this.roomId,
      cursor: {
        file: relativePath,
        line: selection.active.line,
        character: selection.active.character,
        userId: this.userId,
        displayName: this.displayName,
        color: this.color,
      },
    });

    this.lastSend = Date.now();
  }

  dispose(): void {
    this.stop();
    this.decorationManager.dispose();
    for (const d of this.disposables) d.dispose();
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
  }
}
