import * as vscode from 'vscode';
import type { FileActivityPayload } from '@codemeet/shared';
import type { TypedSocket } from '../ConnectionManager.js';

export interface PeerActivity {
  userId: string;
  displayName: string;
  file: string;
}

/**
 * Tracks which files each peer has open/active.
 * Notifies peers when the local user opens or closes a file.
 */
export class FileOpenTracker implements vscode.Disposable {
  private socket: TypedSocket | null = null;
  private roomId: string | null = null;
  private userId = '';
  private displayName = '';
  private disposables: vscode.Disposable[] = [];

  /** userId → set of open files */
  private peerFiles = new Map<string, Set<string>>();

  private readonly _onActivityChanged = new vscode.EventEmitter<Map<string, PeerActivity[]>>();
  public readonly onActivityChanged = this._onActivityChanged.event;

  start(socket: TypedSocket, roomId: string, userId: string, displayName: string): void {
    this.socket = socket;
    this.roomId = roomId;
    this.userId = userId;
    this.displayName = displayName;

    // Track local editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.sendActivity(editor.document.uri, 'open');
        }
      }),
    );

    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.sendActivity(doc.uri, 'close');
      }),
    );

    // Listen for remote file activity
    socket.on('file-activity', (data: FileActivityPayload) => {
      if (data.roomId === this.roomId && data.userId !== this.userId) {
        this.handleRemoteActivity(data);
      }
    });

    // Send current active file
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      this.sendActivity(activeEditor.document.uri, 'open');
    }
  }

  stop(): void {
    this.socket = null;
    this.roomId = null;
    this.peerFiles.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  /** Remove a peer's tracked files (on user-left). */
  removePeer(userId: string): void {
    this.peerFiles.delete(userId);
    this.emitActivity();
  }

  /** Get activity grouped by file. */
  getActivityByFile(): Map<string, PeerActivity[]> {
    const result = new Map<string, PeerActivity[]>();
    for (const [userId, files] of this.peerFiles) {
      for (const file of files) {
        const list = result.get(file) ?? [];
        list.push({ userId, displayName: userId, file });
        result.set(file, list);
      }
    }
    return result;
  }

  private sendActivity(uri: vscode.Uri, action: 'open' | 'close'): void {
    if (!this.socket || !this.roomId) return;
    if (uri.scheme !== 'file') return;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) return;

    const relativePath = vscode.workspace.asRelativePath(uri, false);

    this.socket.emit('file-activity', {
      roomId: this.roomId,
      userId: this.userId,
      displayName: this.displayName,
      file: relativePath,
      action,
    });
  }

  private handleRemoteActivity(data: FileActivityPayload): void {
    let files = this.peerFiles.get(data.userId);
    if (!files) {
      files = new Set();
      this.peerFiles.set(data.userId, files);
    }

    if (data.action === 'open') {
      // Replace: each peer has one "active" file at a time
      files.clear();
      files.add(data.file);
    } else {
      files.delete(data.file);
    }

    this.emitActivity();
  }

  private emitActivity(): void {
    this._onActivityChanged.fire(this.getActivityByFile());
  }

  dispose(): void {
    this.stop();
    this._onActivityChanged.dispose();
  }
}
