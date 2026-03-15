import { Server, Socket } from 'socket.io';
import bcrypt from 'bcrypt';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  CreateRoomPayload,
  JoinRoomPayload,
  JoinResponsePayload,
  EditPatchRelayPayload,
  CursorUpdateRelayPayload,
  FileTreePayload,
  FileActivityPayload,
  NoteUpdatePayload,
  NoteTypingPayload,
  YjsUpdatePayload,
  YjsSyncRequestPayload,
  YjsSyncResponsePayload,
} from '@codemeet/shared';
import { RoomStore } from '../store/RoomStore.js';
import { setDisplayName, getDisplayName, removeDisplayName } from '../store/displayNames.js';

type RoomSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export const roomStore = new RoomStore();

export function registerRoomsNamespace(io: Server): void {
  const rooms = io.of('/rooms');

  rooms.on('connection', (socket: RoomSocket) => {
    console.log(`[/rooms] connected: ${socket.id}`);

    // ── Create Room ──
    socket.on('create-room', (payload: CreateRoomPayload) => {
      const { roomId, passwordHash, scope, displayName } = payload;

      if (roomStore.get(roomId)) {
        socket.emit('error', { message: 'Room ID already exists' });
        return;
      }

      roomStore.create(roomId, socket.id, passwordHash, scope);
      setDisplayName(socket.id, displayName);
      socket.join(roomId);

      console.log(`[/rooms] room created: ${roomId} by ${displayName}`);
      socket.emit('room-created', { roomId });
    });

    // ── Join Room ──
    socket.on('join-room', async (payload: JoinRoomPayload) => {
      const { roomId, password, displayName } = payload;
      const room = roomStore.get(roomId);

      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      // Validate: compare raw password against stored bcrypt hash
      const valid = await bcrypt.compare(password, room.passwordHash).catch(() => false);

      if (!valid) {
        socket.emit('join-rejected', { roomId, reason: 'Invalid password' });
        return;
      }

      setDisplayName(socket.id, displayName);

      // Send join-request to the host for approval
      const hostSocket = rooms.sockets.get(room.hostSocketId);
      if (!hostSocket) {
        socket.emit('error', { message: 'Host is not connected' });
        return;
      }

      console.log(`[/rooms] join-request: ${displayName} → room ${roomId}`);
      hostSocket.emit('join-request', {
        roomId,
        guestSocketId: socket.id,
        guestDisplayName: displayName,
      });
    });

    // ── Host responds to join request ──
    socket.on('join-response', (payload: JoinResponsePayload) => {
      const { roomId, guestSocketId, accepted } = payload;
      const room = roomStore.get(roomId);

      if (!room || room.hostSocketId !== socket.id) {
        socket.emit('error', { message: 'Not authorized' });
        return;
      }

      const guestSocket = rooms.sockets.get(guestSocketId);
      if (!guestSocket) return;

      if (!accepted) {
        guestSocket.emit('join-rejected', { roomId, reason: 'Host rejected your request' });
        console.log(`[/rooms] join rejected: ${guestSocketId} from room ${roomId}`);
        return;
      }

      // Approve: add to room
      roomStore.addMember(roomId, guestSocketId);
      guestSocket.join(roomId);

      // Build member list for the approved guest
      const members = room.members.map((sid) =>
        roomStore.buildMember(roomId, sid, getDisplayName(sid)),
      );

      guestSocket.emit('join-approved', { roomId, members });

      // Notify all existing members about the new user
      const newMember = roomStore.buildMember(roomId, guestSocketId, getDisplayName(guestSocketId));
      socket.to(roomId).emit('user-joined', { roomId, member: newMember });

      console.log(`[/rooms] join approved: ${getDisplayName(guestSocketId)} → room ${roomId}`);
    });

    // ── Edit patch relay (broadcast to other room members) ──
    socket.on('edit-patch', (payload: EditPatchRelayPayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        socket.to(payload.roomId).emit('edit-patch', payload);
        roomStore.touch(payload.roomId);
      }
    });

    // ── Cursor update relay (broadcast to other room members) ──
    socket.on('cursor-update', (payload: CursorUpdateRelayPayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        socket.to(payload.roomId).emit('cursor-update', payload);
      }
    });

    // ── File tree relay (host sends tree to all guests) ──
    socket.on('file-tree', (payload: FileTreePayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        socket.to(payload.roomId).emit('file-tree', payload);
      }
    });

    // ── File activity relay (broadcast which file a user has open) ──
    socket.on('file-activity', (payload: FileActivityPayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        socket.to(payload.roomId).emit('file-activity', payload);
      }
    });

    // ── Note update relay (broadcast shared note changes) ──
    socket.on('note-update', (payload: NoteUpdatePayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        socket.to(payload.roomId).emit('note-update', payload);
      }
    });

    // ── Note typing indicator relay ──
    socket.on('note-typing', (payload: NoteTypingPayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        socket.to(payload.roomId).emit('note-typing', payload);
      }
    });

    // ── Yjs CRDT update relay (broadcast binary doc updates) ──
    socket.on('yjs-update', (payload: YjsUpdatePayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        socket.to(payload.roomId).emit('yjs-update', payload);
      }
    });

    // ── Yjs sync request (guest asks host for full doc state) ──
    socket.on('yjs-sync-request', (payload: YjsSyncRequestPayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        // Forward to host (first member is host)
        const hostId = room.members[0];
        if (hostId && hostId !== socket.id) {
          socket.to(hostId).emit('yjs-sync-request', payload);
        }
      }
    });

    // ── Yjs sync response (host sends full doc state to requester) ──
    socket.on('yjs-sync-response', (payload: YjsSyncResponsePayload) => {
      const room = roomStore.get(payload.roomId);
      if (room && room.members.includes(socket.id)) {
        socket.to(payload.targetId).emit('yjs-sync-response', payload);
      }
    });

    // ── Leave Room ──
    socket.on('leave-room', ({ roomId }: { roomId: string }) => {
      handleLeaveRoom(socket, roomId, rooms);
    });

    // ── Disconnect ──
    socket.on('disconnect', () => {
      const userRooms = roomStore.getRoomsBySocket(socket.id);
      for (const room of userRooms) {
        handleLeaveRoom(socket, room.id, rooms);
      }
      removeDisplayName(socket.id);
      console.log(`[/rooms] disconnected: ${socket.id}`);
    });
  });
}

function handleLeaveRoom(
  socket: RoomSocket,
  roomId: string,
  namespace: ReturnType<Server['of']>,
): void {
  const room = roomStore.get(roomId);
  if (!room) return;

  // Host leaving → close room
  if (room.hostSocketId === socket.id) {
    namespace.to(roomId).emit('room-closed', {
      roomId,
      reason: 'Host disconnected',
    });
    // Remove all sockets from the Socket.IO room
    namespace.in(roomId).socketsLeave(roomId);
    roomStore.delete(roomId);
    console.log(`[/rooms] room closed: ${roomId} (host left)`);
  } else {
    // Guest leaving
    roomStore.removeMember(roomId, socket.id);
    socket.leave(roomId);
    namespace.to(roomId).emit('user-left', { roomId, socketId: socket.id });
    console.log(`[/rooms] user left: ${socket.id} from room ${roomId}`);
  }
}
