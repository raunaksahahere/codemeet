/** Room scope — what is being shared. */
export type RoomScope = 'file' | 'folder' | 'workspace';

/** Room state stored on the signaling server. */
export interface Room {
  id: string;
  hostSocketId: string;
  /** bcrypt hash of the room password. */
  passwordHash: string;
  scope: RoomScope;
  /** Unix timestamp (ms) when room was created. */
  createdAt: number;
  /** Unix timestamp (ms) of last activity. */
  lastActivity: number;
  /** TTL in minutes — rooms auto-expire after inactivity. */
  ttlMinutes: number;
  /** Connected member socket IDs. */
  members: string[];
}

/** Lightweight member info shared with the sidebar. */
export interface RoomMember {
  socketId: string;
  displayName: string;
  color: string;
}
