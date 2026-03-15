import * as vscode from 'vscode';
import type { EditPatch, PatchRange } from '@codemeet/shared';

/**
 * Detects local document changes and converts them into EditPatch objects.
 * Listens on `onDidChangeTextDocument`.
 */
export class EditDetector implements vscode.Disposable {
  private disposable: vscode.Disposable;
  private revCounters = new Map<string, number>();

  /** Set of file paths currently being edited remotely — suppress re-broadcast. */
  public suppressedFiles = new Set<string>();

  private readonly _onPatch = new vscode.EventEmitter<EditPatch>();
  public readonly onPatch = this._onPatch.event;

  constructor(private readonly userId: string) {
    this.disposable = vscode.workspace.onDidChangeTextDocument((e) => {
      this.handleChange(e);
    });
  }

  private handleChange(event: vscode.TextDocumentChangeEvent): void {
    const doc = event.document;

    // Ignore non-file schemes (output, debug console, etc.)
    if (doc.uri.scheme !== 'file') return;

    // Ignore if no actual content changes
    if (event.contentChanges.length === 0) return;

    const filePath = this.getRelativePath(doc.uri);
    if (!filePath) return;

    // Suppress patches caused by applying remote edits
    if (this.suppressedFiles.has(filePath)) return;

    for (const change of event.contentChanges) {
      const rev = this.nextRev(filePath);

      const range: PatchRange = {
        startLine: change.range.start.line,
        startCharacter: change.range.start.character,
        endLine: change.range.end.line,
        endCharacter: change.range.end.character,
      };

      const patch: EditPatch = {
        file: filePath,
        range,
        text: change.text,
        rev,
        userId: this.userId,
      };

      this._onPatch.fire(patch);
    }
  }

  private nextRev(file: string): number {
    const current = this.revCounters.get(file) ?? 0;
    const next = current + 1;
    this.revCounters.set(file, next);
    return next;
  }

  /** Get the revision counter for a file (for conflict detection). */
  getRev(file: string): number {
    return this.revCounters.get(file) ?? 0;
  }

  /** Update rev counter when receiving remote patches. */
  setRev(file: string, rev: number): void {
    const current = this.revCounters.get(file) ?? 0;
    if (rev > current) {
      this.revCounters.set(file, rev);
    }
  }

  private getRelativePath(uri: vscode.Uri): string | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) return null;
    return vscode.workspace.asRelativePath(uri, false);
  }

  dispose(): void {
    this.disposable.dispose();
    this._onPatch.dispose();
  }
}
