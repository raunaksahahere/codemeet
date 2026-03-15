import * as vscode from 'vscode';
import { CodeIgnoreScanner } from './CodeIgnoreScanner.js';

/**
 * Watch .codeignore for changes and trigger reload.
 */
export function watchCodeIgnore(scanner: CodeIgnoreScanner): vscode.Disposable {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return { dispose: () => {} };

  const pattern = new vscode.RelativePattern(workspaceFolder, '.codeignore');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  const reload = () => scanner.reload();
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  watcher.onDidDelete(reload);

  return watcher;
}
