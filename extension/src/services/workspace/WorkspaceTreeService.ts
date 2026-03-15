import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { FileTreeEntry, FileTreePayload } from '@codemeet/shared';
import type { TypedSocket } from '../ConnectionManager.js';
import { CodeIgnoreScanner } from './CodeIgnoreScanner.js';

/**
 * Scans and shares the workspace file tree with connected peers.
 * Respects .codeignore patterns to exclude sensitive files.
 */
export class WorkspaceTreeService implements vscode.Disposable {
  private scanner: CodeIgnoreScanner | null = null;
  private socket: TypedSocket | null = null;
  private roomId: string | null = null;
  private cachedTree: FileTreeEntry[] = [];

  private readonly _onRemoteTree = new vscode.EventEmitter<FileTreeEntry[]>();
  public readonly onRemoteTree = this._onRemoteTree.event;

  /** Start sharing the workspace tree. */
  start(socket: TypedSocket, roomId: string, isHost: boolean): void {
    this.socket = socket;
    this.roomId = roomId;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      this.scanner = new CodeIgnoreScanner(workspaceRoot);
    }

    // Listen for incoming file tree from host
    socket.on('file-tree', (data: FileTreePayload) => {
      if (data.roomId === this.roomId) {
        this._onRemoteTree.fire(data.entries);
      }
    });

    // Host sends the file tree to new members
    if (isHost && workspaceRoot) {
      this.scanAndSend();
    }
  }

  /** Re-scan and broadcast the file tree (host only). */
  scanAndSend(): void {
    if (!this.socket || !this.roomId) return;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return;

    this.cachedTree = this.scanDirectory(workspaceRoot, workspaceRoot);
    this.socket.emit('file-tree', {
      roomId: this.roomId,
      entries: this.cachedTree,
    });
    console.log(`[CodeMeet] Sent file tree: ${this.cachedTree.length} entries`);
  }

  getCachedTree(): FileTreeEntry[] {
    return this.cachedTree;
  }

  stop(): void {
    this.socket = null;
    this.roomId = null;
    this.cachedTree = [];
  }

  private scanDirectory(dir: string, root: string, maxDepth = 5, depth = 0): FileTreeEntry[] {
    if (depth > maxDepth) return [];

    const entries: FileTreeEntry[] = [];

    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });

      for (const item of items) {
        const relativePath = path.relative(root, path.join(dir, item.name)).replace(/\\/g, '/');

        // Check .codeignore
        if (this.scanner?.isIgnored(relativePath)) continue;

        if (item.isDirectory()) {
          entries.push({ path: relativePath, type: 'directory' });
          entries.push(...this.scanDirectory(path.join(dir, item.name), root, maxDepth, depth + 1));
        } else if (item.isFile()) {
          entries.push({ path: relativePath, type: 'file' });
        }
      }
    } catch (err) {
      console.warn(`[CodeMeet] Failed to scan ${dir}:`, err);
    }

    return entries;
  }

  dispose(): void {
    this.stop();
    this._onRemoteTree.dispose();
  }
}
