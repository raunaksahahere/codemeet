import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('[CodeMeet] Extension activated');

  // Register the sidebar webview provider
  const sidebarProvider = new SidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codemeet.sidebarView', sidebarProvider),
  );

  // Register commands
  const startRoomCmd = vscode.commands.registerCommand('codemeet.startRoom', async () => {
    vscode.window.showInformationMessage('CodeMeet: Starting a room...');
    // Phase 2 will implement the full room creation flow
  });

  const joinRoomCmd = vscode.commands.registerCommand('codemeet.joinRoom', async () => {
    const roomId = await vscode.window.showInputBox({
      prompt: 'Enter Room ID to join',
      placeHolder: 'e.g. abc-123-xyz',
    });

    if (!roomId) {
      return;
    }

    vscode.window.showInformationMessage(`CodeMeet: Joining room ${roomId}...`);
    // Phase 2 will implement the full join flow
  });

  context.subscriptions.push(startRoomCmd, joinRoomCmd);
}

export function deactivate() {
  console.log('[CodeMeet] Extension deactivated');
}
