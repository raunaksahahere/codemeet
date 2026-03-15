import type { Room, RoomMember } from '@codemeet/shared';

/** Fixed color palette for user assignment. */
const COLORS = [
  '#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd',
  '#56b6c2', '#be5046', '#d19a66', '#abb2bf', '#ef596f',
];

/**
 * In-memory room store with TTL-based auto-expiry.
 */
export class RoomStore {
  private rooms = new Map<string, Room>();
  private expiryTimer: ReturnType<typeof setInterval>;

  constructor(private readonly checkIntervalMs = 60_000) {
    this.expiryTimer = setInterval(() => this.sweepExpired(), this.checkIntervalMs);
  }

  create(
    id: string,
    hostSocketId: string,
    passwordHash: string,
    scope: Room['scope'],
    ttlMinutes = 10,
  ): Room {
    const room: Room = {
      id,
      hostSocketId,
      passwordHash,
      scope,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ttlMinutes,
      members: [hostSocketId],
    };
    this.rooms.set(id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  delete(id: string): boolean {
    return this.rooms.delete(id);
  }

  touch(id: string): void {
    const room = this.rooms.get(id);
    if (room) {
      room.lastActivity = Date.now();
    }
  }

  addMember(roomId: string, socketId: string): void {
    const room = this.rooms.get(roomId);
    if (room && !room.members.includes(socketId)) {
      room.members.push(socketId);
      room.lastActivity = Date.now();
    }
  }

  removeMember(roomId: string, socketId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.members = room.members.filter((id) => id !== socketId);
      room.lastActivity = Date.now();
    }
  }

  getRoomsBySocket(socketId: string): Room[] {
    return Array.from(this.rooms.values()).filter((r) => r.members.includes(socketId));
  }

  getMemberColor(roomId: string, socketId: string): string {
    const room = this.rooms.get(roomId);
    if (!room) return COLORS[0];
    const index = room.members.indexOf(socketId);
    return COLORS[index % COLORS.length];
  }

  buildMember(roomId: string, socketId: string, displayName: string): RoomMember {
    return {
      socketId,
      displayName,
      color: this.getMemberColor(roomId, socketId),
    };
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      const expiresAt = room.lastActivity + room.ttlMinutes * 60_000;
      if (now > expiresAt) {
        console.log(`[RoomStore] Room ${id} expired (inactive ${room.ttlMinutes}min)`);
        this.rooms.delete(id);
      }
    }
  }

  destroy(): void {
    clearInterval(this.expiryTimer);
  }

  get size(): number {
    return this.rooms.size;
  }
}
