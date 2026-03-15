import * as vscode from 'vscode';
import type { EditPatch } from '@codemeet/shared';

/**
 * Applies incoming remote edit patches to the local workspace.
 * Uses workspace.applyEdit with WorkspaceEdit.
 */
export class PatchApplicator {
  private readonly outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('CodeMeet Conflicts');
  }

  /**
   * Apply a remote edit patch to the local workspace.
   * @param patch The edit patch from a remote peer.
   * @param suppressFn Callback to suppress the file from re-broadcasting.
   * @returns true if the patch was applied successfully.
   */
  async apply(
    patch: EditPatch,
    suppressFn: (file: string, fn: () => Promise<void>) => Promise<void>,
  ): Promise<boolean> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return false;

    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, patch.file);

    const range = new vscode.Range(
      new vscode.Position(patch.range.startLine, patch.range.startCharacter),
      new vscode.Position(patch.range.endLine, patch.range.endCharacter),
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(fileUri, range, patch.text);

    try {
      await suppressFn(patch.file, async () => {
        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
          this.logConflict(patch, 'workspace.applyEdit returned false');
        }
      });
      return true;
    } catch (err) {
      this.logConflict(patch, String(err));
      return false;
    }
  }

  private logConflict(patch: EditPatch, reason: string): void {
    this.outputChannel.appendLine(
      `[${new Date().toISOString()}] Conflict applying patch: ` +
        `file=${patch.file}, rev=${patch.rev}, user=${patch.userId}, reason=${reason}`,
    );
  }

  dispose(): void {
    this.outputChannel.dispose();
  }
}
