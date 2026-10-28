import * as vscode from 'vscode';
import { Controller } from './controller';
import { PrivateNotesPanel } from './services/notes/PrivateNotesPanel';

export function activate(context: vscode.ExtensionContext): { e2e?: ReturnType<Controller['e2e']> } {
  const out = vscode.window.createOutputChannel('CodeMeet');
  const controller = new Controller(context, out);
  context.subscriptions.push(
    out,
    controller,
    vscode.window.registerWebviewViewProvider('codemeet.sidebarView', controller.sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider('codemeet-proposal', controller.proposalDocs),
  );

  const cmd = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const guard = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      void vscode.window.showErrorMessage(`CodeMeet: ${(e as Error).message}`);
    }
  };
  cmd('codemeet.createRoom', guard(() => controller.createRoom()));
  cmd('codemeet.joinRoom', guard(() => controller.joinRoom()));
  cmd('codemeet.leaveRoom', guard(() => controller.leaveRoom()));
  cmd('codemeet.runAgent', guard(() => controller.runMyAgent()));
  cmd('codemeet.grantPermission', guard(() => controller.grantPermission()));
  cmd('codemeet.revokePermission', guard(() => controller.revokePermission()));
  cmd('codemeet.responderMode', guard(() => controller.responderMode()));
  cmd('codemeet.showMessages', guard(() => controller.showMessages()));
  cmd('codemeet.reviewProposal', guard(() => controller.reviewProposal()));
  cmd('codemeet.approveProposal', guard(() => controller.decideProposal(undefined, true)));
  cmd('codemeet.rejectProposal', guard(() => controller.decideProposal(undefined, false)));
  cmd('codemeet.copyRoomId', guard(() => controller.copyRoomId()));
  cmd('codemeet.openSharedNotes', guard(() => controller.openSharedNotes()));
  cmd('codemeet.openPrivateNotes', () => PrivateNotesPanel.createOrShow(context.extensionUri, context.globalState));
  cmd('codemeet.showLog', () => out.show());

  // Reconnect to a saved session after VS Code restarts; failures are reported, never fatal.
  if (process.env.CODEMEET_E2E !== '1') void controller.resumeSaved().catch((e: Error) => out.appendLine(`resume failed: ${e.message}`));
  // The test seam exists only for the automated extension-host test.
  return process.env.CODEMEET_E2E === '1' ? { e2e: controller.e2e() } : {};
}

export function deactivate(): void {
  // Disposables registered in activate() release the session, watchers and timers.
}
