import * as vscode from 'vscode';

interface RemoteCursor {
  file: string;
  line: number;
  character: number;
  displayName: string;
  color: string;
}

/** Manages VS Code decoration types for rendering remote cursors. */
export class CursorDecorationManager implements vscode.Disposable {
  /** userId → cursor state */
  private cursors = new Map<string, RemoteCursor>();
  /** userId → decoration type for the caret */
  private caretDecorations = new Map<string, vscode.TextEditorDecorationType>();
  /** userId → decoration type for the name tag */
  private tagDecorations = new Map<string, vscode.TextEditorDecorationType>();

  private refreshTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Periodically refresh decorations (handles editor switches)
    this.refreshTimer = setInterval(() => this.renderAll(), 500);
  }

  /** Update or add a remote cursor. */
  setCursor(userId: string, cursor: RemoteCursor): void {
    this.cursors.set(userId, cursor);
    this.ensureDecorationTypes(userId, cursor.color, cursor.displayName);
    this.renderAll();
  }

  /** Remove a peer's cursor (on disconnect). */
  removeCursor(userId: string): void {
    this.cursors.delete(userId);
    this.caretDecorations.get(userId)?.dispose();
    this.caretDecorations.delete(userId);
    this.tagDecorations.get(userId)?.dispose();
    this.tagDecorations.delete(userId);
  }

  /** Clear all remote cursors. */
  clearAll(): void {
    for (const [id] of this.cursors) {
      this.removeCursor(id);
    }
  }

  private ensureDecorationTypes(
    userId: string,
    color: string,
    displayName: string,
  ): void {
    // Only create if not already exists
    if (!this.caretDecorations.has(userId)) {
      // Caret: a thin colored border-left on the character
      const caretType = vscode.window.createTextEditorDecorationType({
        borderWidth: '0 0 0 2px',
        borderStyle: 'solid',
        borderColor: color,
        // No background to avoid clashing with syntax highlighting
      });
      this.caretDecorations.set(userId, caretType);

      // Name tag: shown after the cursor position
      const tagType = vscode.window.createTextEditorDecorationType({
        after: {
          contentText: ` ${displayName}`,
          color: color,
          fontStyle: 'italic',
        },
      });
      this.tagDecorations.set(userId, tagType);
    }
  }

  private renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== 'file') continue;

      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (!workspaceFolder) continue;

      const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

      for (const [userId, cursor] of this.cursors) {
        const caretType = this.caretDecorations.get(userId);
        const tagType = this.tagDecorations.get(userId);
        if (!caretType || !tagType) continue;

        if (cursor.file === relativePath) {
          const pos = new vscode.Position(cursor.line, cursor.character);
          const range = new vscode.Range(pos, pos);

          editor.setDecorations(caretType, [{ range }]);
          editor.setDecorations(tagType, [{ range }]);
        } else {
          // Clear decorations for this user in files they're not editing
          editor.setDecorations(caretType, []);
          editor.setDecorations(tagType, []);
        }
      }
    }
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    this.clearAll();
  }
}
