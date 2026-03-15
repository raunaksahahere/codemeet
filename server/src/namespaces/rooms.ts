import { Namespace, Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@codemeet/shared';

type TypedNamespace = Namespace<ClientToServerEvents, ServerToClientEvents>;

/**
 * `/rooms` namespace — handles room creation, joining, and lifecycle.
 * Auth logic will be added in Phase 2.
 */
export function registerRoomsNamespace(io: Server): TypedNamespace {
  const rooms: TypedNamespace = io.of('/rooms');

  rooms.on('connection', (socket) => {
    console.log(`[/rooms] client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`[/rooms] client disconnected: ${socket.id}`);
    });
  });

  return rooms;
}
