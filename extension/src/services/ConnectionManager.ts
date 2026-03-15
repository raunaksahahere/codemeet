import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@codemeet/shared';
import * as vscode from 'vscode';

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const DEFAULT_SERVER_URL = 'http://localhost:3001';

/**
 * Manages Socket.IO connections to the signaling server.
 * Provides typed sockets for both /rooms and /signal namespaces.
 */
export class ConnectionManager {
  private roomsSocket: TypedSocket | null = null;
  private signalSocket: TypedSocket | null = null;
  private serverUrl: string;

  private readonly _onConnected = new vscode.EventEmitter<void>();
  private readonly _onDisconnected = new vscode.EventEmitter<string>();

  public readonly onConnected = this._onConnected.event;
  public readonly onDisconnected = this._onDisconnected.event;

  constructor() {
    const config = vscode.workspace.getConfiguration('codemeet');
    this.serverUrl = config.get<string>('serverUrl') ?? DEFAULT_SERVER_URL;
  }

  connect(): { rooms: TypedSocket; signal: TypedSocket } {
    if (this.roomsSocket?.connected && this.signalSocket?.connected) {
      return { rooms: this.roomsSocket, signal: this.signalSocket };
    }

    this.roomsSocket = io(`${this.serverUrl}/rooms`, {
      transports: ['websocket'],
      autoConnect: true,
    }) as TypedSocket;

    this.signalSocket = io(`${this.serverUrl}/signal`, {
      transports: ['websocket'],
      autoConnect: true,
    }) as TypedSocket;

    this.roomsSocket.on('connect', () => {
      console.log('[CodeMeet] Connected to /rooms');
      this._onConnected.fire();
    });

    this.roomsSocket.on('disconnect', (reason) => {
      console.log(`[CodeMeet] Disconnected from /rooms: ${reason}`);
      this._onDisconnected.fire(reason);
    });

    return { rooms: this.roomsSocket, signal: this.signalSocket };
  }

  getRoomsSocket(): TypedSocket | null {
    return this.roomsSocket;
  }

  getSignalSocket(): TypedSocket | null {
    return this.signalSocket;
  }

  disconnect(): void {
    this.roomsSocket?.disconnect();
    this.signalSocket?.disconnect();
    this.roomsSocket = null;
    this.signalSocket = null;
  }

  dispose(): void {
    this._onConnected.dispose();
    this._onDisconnected.dispose();
    this.disconnect();
  }
}
