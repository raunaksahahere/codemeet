import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { ConnectionManager } from './services/ConnectionManager';
import { RoomService } from './services/RoomService';

export function activate(context: vscode.ExtensionContext) {
  console.log('[CodeMeet] Extension activated');

  const connectionManager = new ConnectionManager();
  const roomService = new RoomService(connectionManager);

  // Register the sidebar webview provider
  const sidebarProvider = new SidebarProvider(context.extensionUri, roomService);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codemeet.sidebarView', sidebarProvider),
  );

  // Wire room state changes to sidebar updates
  roomService.onStateChanged((state) => {
    sidebarProvider.updateState(state);
  });

  // Register commands
  const startRoomCmd = vscode.commands.registerCommand('codemeet.startRoom', () => {
    roomService.startRoom();
  });

  const joinRoomCmd = vscode.commands.registerCommand('codemeet.joinRoom', () => {
    roomService.joinRoom();
  });

  const leaveRoomCmd = vscode.commands.registerCommand('codemeet.leaveRoom', () => {
    roomService.leaveRoom();
  });

  context.subscriptions.push(startRoomCmd, joinRoomCmd, leaveRoomCmd);
  context.subscriptions.push({
    dispose: () => {
      connectionManager.dispose();
      roomService.dispose();
    },
  });
}

export function deactivate() {
  console.log('[CodeMeet] Extension deactivated');
}
