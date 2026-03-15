import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { ConnectionManager } from './services/ConnectionManager';
import { RoomService } from './services/RoomService';
import { EditSyncService } from './services/editing/EditSyncService';
import { CursorSyncService } from './services/cursor/CursorSyncService';
import { colorFromId } from './services/ColorService';

export function activate(context: vscode.ExtensionContext) {
  console.log('[CodeMeet] Extension activated');

  const connectionManager = new ConnectionManager();
  const roomService = new RoomService(connectionManager);

  // Phase 3 services — created lazily when room is joined
  let editSync: EditSyncService | null = null;
  let cursorSync: CursorSyncService | null = null;

  // Register the sidebar webview provider
  const sidebarProvider = new SidebarProvider(context.extensionUri, roomService);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codemeet.sidebarView', sidebarProvider),
  );

  // Wire room state changes to sidebar updates + start/stop sync services
  roomService.onStateChanged((state) => {
    sidebarProvider.updateState(state);

    if (state) {
      // Room joined/created — start edit & cursor sync
      const socket = connectionManager.getRoomsSocket();
      if (socket) {
        const userId = socket.id ?? 'unknown';
        const color = colorFromId(userId);

        // Find our display name from members list
        const me = state.members.find((m) => m.socketId === userId);
        const displayName = me?.displayName ?? 'Anonymous';

        if (!editSync) {
          editSync = new EditSyncService(userId);
        }
        editSync.start(socket, state.roomId);

        if (!cursorSync) {
          cursorSync = new CursorSyncService(userId, displayName, color);
        }
        cursorSync.start(socket, state.roomId);

        console.log(`[CodeMeet] Edit & cursor sync started for room ${state.roomId}`);
      }
    } else {
      // Room left — stop sync
      editSync?.stop();
      cursorSync?.stop();
      console.log('[CodeMeet] Edit & cursor sync stopped');
    }
  });

  // Handle peer leaving — remove their cursor
  roomService.onPeerLeft((socketId) => {
    cursorSync?.removePeer(socketId);
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
      editSync?.dispose();
      cursorSync?.dispose();
    },
  });
}

export function deactivate() {
  console.log('[CodeMeet] Extension deactivated');
}
