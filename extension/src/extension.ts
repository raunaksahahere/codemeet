import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { ConnectionManager } from './services/ConnectionManager';
import { RoomService } from './services/RoomService';
import { YjsEditService } from './services/editing/YjsEditService';
import { CursorSyncService } from './services/cursor/CursorSyncService';
import { WorkspaceTreeService } from './services/workspace/WorkspaceTreeService';
import { FileOpenTracker } from './services/workspace/FileOpenTracker';
import { watchCodeIgnore } from './services/workspace/watchCodeIgnore';
import { CodeIgnoreScanner } from './services/workspace/CodeIgnoreScanner';
import { SharedNotesPanel } from './services/notes/SharedNotesPanel';
import { PrivateNotesPanel } from './services/notes/PrivateNotesPanel';
import { colorFromId } from './services/ColorService';

export function activate(context: vscode.ExtensionContext) {
  console.log('[CodeMeet] Extension activated');

  const connectionManager = new ConnectionManager();
  const roomService = new RoomService(connectionManager);

  // Services — created lazily when room is joined
  let editSync: YjsEditService | null = null;
  let cursorSync: CursorSyncService | null = null;
  let workspaceTree: WorkspaceTreeService | null = null;
  let fileTracker: FileOpenTracker | null = null;
  let codeignoreWatcher: vscode.Disposable | null = null;

  // Track current room info for notes panels
  let currentRoomId: string | null = null;
  let currentUserId = '';
  let currentDisplayName = '';

  // Register the sidebar webview provider
  const sidebarProvider = new SidebarProvider(context.extensionUri, roomService);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codemeet.sidebarView', sidebarProvider),
  );

  // Wire room state changes to sidebar updates + start/stop sync services
  roomService.onStateChanged((state) => {
    sidebarProvider.updateState(state);

    if (state) {
      // Room joined/created — start all sync services
      const socket = connectionManager.getRoomsSocket();
      if (socket) {
        const userId = socket.id ?? 'unknown';
        const color = colorFromId(userId);
        const me = state.members.find((m) => m.socketId === userId);
        const displayName = me?.displayName ?? 'Anonymous';

        currentRoomId = state.roomId;
        currentUserId = userId;
        currentDisplayName = displayName;

        // Edit sync (CRDT via Yjs)
        if (!editSync) {
          editSync = new YjsEditService();
        }
        editSync.start(socket, state.roomId, state.isHost);

        // Cursor sync
        if (!cursorSync) {
          cursorSync = new CursorSyncService(userId, displayName, color);
        }
        cursorSync.start(socket, state.roomId);

        // Workspace tree sync
        if (!workspaceTree) {
          workspaceTree = new WorkspaceTreeService();
        }
        workspaceTree.start(socket, state.roomId, state.isHost);

        // File open tracking
        if (!fileTracker) {
          fileTracker = new FileOpenTracker();
        }
        fileTracker.start(socket, state.roomId, userId, displayName);

        // Watch .codeignore
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
          const scanner = new CodeIgnoreScanner(workspaceRoot);
          codeignoreWatcher = watchCodeIgnore(scanner);
        }

        // Wire file activity changes to sidebar
        fileTracker.onActivityChanged((activity) => {
          sidebarProvider.updateFileActivity(activity);
        });

        console.log(`[CodeMeet] All sync services started for room ${state.roomId}`);
      }
    } else {
      // Room left — stop all sync
      editSync?.stop();
      cursorSync?.stop();
      workspaceTree?.stop();
      fileTracker?.stop();
      codeignoreWatcher?.dispose();
      codeignoreWatcher = null;
      currentRoomId = null;
      sidebarProvider.updateFileActivity(new Map());
      console.log('[CodeMeet] All sync services stopped');
    }
  });

  // Handle peer leaving — remove their cursor and file tracking
  roomService.onPeerLeft((socketId) => {
    cursorSync?.removePeer(socketId);
    fileTracker?.removePeer(socketId);
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

  const sharedNotesCmd = vscode.commands.registerCommand('codemeet.openSharedNotes', () => {
    const socket = connectionManager.getRoomsSocket();
    if (!socket || !currentRoomId) {
      vscode.window.showWarningMessage('Join a room first to use shared notes.');
      return;
    }
    SharedNotesPanel.createOrShow(
      context.extensionUri,
      socket,
      currentRoomId,
      currentUserId,
      currentDisplayName,
    );
  });

  const privateNotesCmd = vscode.commands.registerCommand('codemeet.openPrivateNotes', () => {
    PrivateNotesPanel.createOrShow(context.extensionUri, context.globalState);
  });

  context.subscriptions.push(startRoomCmd, joinRoomCmd, leaveRoomCmd, sharedNotesCmd, privateNotesCmd);
  context.subscriptions.push({
    dispose: () => {
      connectionManager.dispose();
      roomService.dispose();
      editSync?.dispose();
      cursorSync?.dispose();
      workspaceTree?.dispose();
      fileTracker?.dispose();
      codeignoreWatcher?.dispose();
      SharedNotesPanel.currentPanel?.dispose();
      PrivateNotesPanel.currentPanel?.dispose();
    },
  });
}

export function deactivate() {
  console.log('[CodeMeet] Extension deactivated');
}
