import * as vscode from 'vscode';
import * as bcryptjs from 'bcryptjs';
import { nanoid } from 'nanoid';
import type {
  RoomMember,
  RoomCreatedPayload,
  JoinRequestPayload,
  JoinApprovedPayload,
  JoinRejectedPayload,
  UserJoinedPayload,
  UserLeftPayload,
  RoomClosedPayload,
  ErrorPayload,
} from '@codemeet/shared';
import { ConnectionManager, TypedSocket } from './ConnectionManager.js';

export interface RoomState {
  roomId: string;
  isHost: boolean;
  members: RoomMember[];
}

/**
 * Manages room lifecycle from the extension side:
 * create, join, leave, and host-approval flow.
 */
export class RoomService {
  private state: RoomState | null = null;
  private roomsSocket: TypedSocket | null = null;
  private listenedSocket: TypedSocket | null = null;

  private readonly _onStateChanged = new vscode.EventEmitter<RoomState | null>();
  public readonly onStateChanged = this._onStateChanged.event;

  private readonly _onPeerLeft = new vscode.EventEmitter<string>();
  public readonly onPeerLeft = this._onPeerLeft.event;

  constructor(private readonly connectionManager: ConnectionManager) {}

  /** Start a new room as host. */
  async startRoom(): Promise<void> {
    // Collect room info via QuickPick/InputBox
    const customId = await vscode.window.showInputBox({
      prompt: 'Room ID (leave blank for auto-generated)',
      placeHolder: 'my-room',
    });
    if (customId === undefined) return; // cancelled

    const password = await vscode.window.showInputBox({
      prompt: 'Set a room password',
      password: true,
      validateInput: (v) => (v.length < 3 ? 'Password must be at least 3 characters' : null),
    });
    if (!password) return;

    const scope = await vscode.window.showQuickPick(['workspace', 'folder', 'file'], {
      placeHolder: 'What do you want to share?',
    });
    if (!scope) return;

    const displayName = await this.getDisplayName();
    if (!displayName) return;

    const roomId = customId?.trim() || nanoid(10);
    // Use async bcrypt to avoid blocking the extension host event loop
    const passwordHash = await bcryptjs.hash(password, 10);

    // Connect and emit create-room once socket is connected
    const { rooms } = this.connectionManager.connect();
    this.roomsSocket = rooms;
    this.setupListeners();

    const doCreate = () => {
      rooms.emit('create-room', {
        roomId,
        passwordHash,
        scope: scope as 'workspace' | 'folder' | 'file',
        displayName,
      });
    };

    if (rooms.connected) {
      doCreate();
    } else {
      rooms.once('connect', doCreate);
    }
  }

  /** Join an existing room as a guest. */
  async joinRoom(): Promise<void> {
    const roomId = await vscode.window.showInputBox({
      prompt: 'Enter Room ID to join',
      placeHolder: 'e.g. abc-123-xyz',
      validateInput: (v) => (v.trim().length === 0 ? 'Room ID is required' : null),
    });
    if (!roomId) return;

    const password = await vscode.window.showInputBox({
      prompt: 'Enter room password',
      password: true,
    });
    if (!password) return;

    const displayName = await this.getDisplayName();
    if (!displayName) return;

    const { rooms } = this.connectionManager.connect();
    this.roomsSocket = rooms;
    this.setupListeners();

    const doJoin = () => {
      rooms.emit('join-room', { roomId: roomId!, password: password!, displayName: displayName! });
      vscode.window.showInformationMessage(`Requesting to join room ${roomId}...`);
    };

    if (rooms.connected) {
      doJoin();
    } else {
      rooms.once('connect', doJoin);
    }
  }

  /** Leave the current room. */
  leaveRoom(): void {
    if (!this.state || !this.roomsSocket) return;

    this.roomsSocket.emit('leave-room', { roomId: this.state.roomId });
    this.clearState();
    this.connectionManager.disconnect();
    vscode.window.showInformationMessage('Left the room.');
  }

  getState(): RoomState | null {
    return this.state;
  }

  private setupListeners(): void {
    if (!this.roomsSocket) return;
    // Avoid registering duplicate listeners on the same socket
    if (this.roomsSocket === this.listenedSocket) return;
    this.listenedSocket = this.roomsSocket;
    const socket = this.roomsSocket;

    // ── Host: room created ──
    socket.on('room-created', (data: RoomCreatedPayload) => {
      console.log('[CodeMeet] room-created received:', data.roomId);
      this.state = {
        roomId: data.roomId,
        isHost: true,
        members: [
          {
            socketId: socket.id ?? '',
            displayName: 'You (Host)',
            color: '#61afef',
          },
        ],
      };
      this._onStateChanged.fire(this.state);
      vscode.window.showInformationMessage(`Room created! ID: ${data.roomId}`);
    });

    // ── Host: incoming join request ──
    socket.on('join-request', async (data: JoinRequestPayload) => {
      const action = await vscode.window.showInformationMessage(
        `${data.guestDisplayName} wants to join room ${data.roomId}`,
        'Accept',
        'Reject',
      );

      socket.emit('join-response', {
        roomId: data.roomId,
        guestSocketId: data.guestSocketId,
        accepted: action === 'Accept',
      });
    });

    // ── Guest: join approved ──
    socket.on('join-approved', (data: JoinApprovedPayload) => {
      this.state = { roomId: data.roomId, isHost: false, members: data.members };
      this._onStateChanged.fire(this.state);
      vscode.window.showInformationMessage(`Joined room ${data.roomId}!`);
    });

    // ── Guest: join rejected ──
    socket.on('join-rejected', (data: JoinRejectedPayload) => {
      vscode.window.showWarningMessage(`Could not join ${data.roomId}: ${data.reason}`);
      this.connectionManager.disconnect();
    });

    // ── New member joined ──
    socket.on('user-joined', (data: UserJoinedPayload) => {
      if (this.state) {
        this.state.members.push(data.member);
        this._onStateChanged.fire(this.state);
        vscode.window.showInformationMessage(`${data.member.displayName} joined the room`);
      }
    });

    // ── Member left ──
    socket.on('user-left', (data: UserLeftPayload) => {
      if (this.state) {
        this.state.members = this.state.members.filter((m) => m.socketId !== data.socketId);
        this._onStateChanged.fire(this.state);
        this._onPeerLeft.fire(data.socketId);
      }
    });

    // ── Room closed ──
    socket.on('room-closed', (data: RoomClosedPayload) => {
      vscode.window.showWarningMessage(`Room ${data.roomId} closed: ${data.reason}`);
      this.clearState();
      this.connectionManager.disconnect();
    });

    // ── Errors ──
    socket.on('error', (data: ErrorPayload) => {
      vscode.window.showErrorMessage(`CodeMeet error: ${data.message}`);
    });
  }

  private clearState(): void {
    this.state = null;
    this._onStateChanged.fire(null);
  }

  private async getDisplayName(): Promise<string | undefined> {
    return vscode.window.showInputBox({
      prompt: 'Your display name',
      placeHolder: 'e.g. Raunak',
      validateInput: (v) => (v.trim().length === 0 ? 'Name is required' : null),
    });
  }

  dispose(): void {
    this._onStateChanged.dispose();
    this._onPeerLeft.dispose();
  }
}
