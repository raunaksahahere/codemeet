// ── Socket.IO event type definitions ──

import type { RoomScope, RoomMember } from './room.js';

// ── Client → Server events ──

export interface CreateRoomPayload {
  roomId: string;
  passwordHash: string;
  scope: RoomScope;
  displayName: string;
}

export interface JoinRoomPayload {
  roomId: string;
  /** Raw password — server compares against stored bcrypt hash. */
  password: string;
  displayName: string;
}

export interface JoinResponsePayload {
  roomId: string;
  guestSocketId: string;
  accepted: boolean;
}

// ── Server → Client events ──

export interface RoomCreatedPayload {
  roomId: string;
}

export interface JoinRequestPayload {
  roomId: string;
  guestSocketId: string;
  guestDisplayName: string;
}

export interface JoinApprovedPayload {
  roomId: string;
  members: RoomMember[];
}

export interface JoinRejectedPayload {
  roomId: string;
  reason: string;
}

export interface UserJoinedPayload {
  roomId: string;
  member: RoomMember;
}

export interface UserLeftPayload {
  roomId: string;
  socketId: string;
}

export interface RoomClosedPayload {
  roomId: string;
  reason: string;
}

export interface ErrorPayload {
  message: string;
}

// ── WebRTC signaling events ──

/** Portable SDP description (mirrors RTCSessionDescriptionInit). */
export interface SdpPayload {
  type: 'offer' | 'answer';
  sdp: string;
}

/** Portable ICE candidate (mirrors RTCIceCandidateInit). */
export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface SignalOfferPayload {
  targetSocketId: string;
  sdp: SdpPayload;
}

export interface SignalAnswerPayload {
  targetSocketId: string;
  sdp: SdpPayload;
}

export interface SignalIceCandidatePayload {
  targetSocketId: string;
  candidate: IceCandidatePayload;
}

// ── Cursor sync events (sent over DataChannel / relay) ──

export interface CursorUpdatePayload {
  file: string;
  line: number;
  character: number;
  userId: string;
  displayName: string;
  color: string;
}

// ── Data relay events (Socket.IO relay until WebRTC DataChannel is active) ──

export interface EditPatchRelayPayload {
  roomId: string;
  patch: import('./patches.js').EditPatch;
}

export interface CursorUpdateRelayPayload {
  roomId: string;
  cursor: CursorUpdatePayload;
}

// ── Workspace sync events ──

/** A single entry in the workspace file tree. */
export interface FileTreeEntry {
  /** Relative path from workspace root. */
  path: string;
  type: 'file' | 'directory';
}

/** Sent by host to share the workspace file tree with guests. */
export interface FileTreePayload {
  roomId: string;
  entries: FileTreeEntry[];
}

/** Notifies peers which file a user has open/closed. */
export interface FileActivityPayload {
  roomId: string;
  userId: string;
  displayName: string;
  /** The file that was opened/closed (relative path). */
  file: string;
  action: 'open' | 'close';
}

// ── Shared notes events ──

/** Sent when a user updates the shared notes content. */
export interface NoteUpdatePayload {
  roomId: string;
  userId: string;
  displayName: string;
  /** Full content of the shared note. */
  content: string;
  /** Incrementing revision for ordering. */
  rev: number;
}

/** Typing presence indicator for shared notes. */
export interface NoteTypingPayload {
  roomId: string;
  userId: string;
  displayName: string;
  isTyping: boolean;
}

// ── Aggregate event maps for type-safe Socket.IO ──

export interface ClientToServerEvents {
  'create-room': (payload: CreateRoomPayload) => void;
  'join-room': (payload: JoinRoomPayload) => void;
  'join-response': (payload: JoinResponsePayload) => void;
  'leave-room': (payload: { roomId: string }) => void;
  'signal-offer': (payload: SignalOfferPayload) => void;
  'signal-answer': (payload: SignalAnswerPayload) => void;
  'signal-ice-candidate': (payload: SignalIceCandidatePayload) => void;
  'edit-patch': (payload: EditPatchRelayPayload) => void;
  'cursor-update': (payload: CursorUpdateRelayPayload) => void;
  'file-tree': (payload: FileTreePayload) => void;
  'file-activity': (payload: FileActivityPayload) => void;
  'note-update': (payload: NoteUpdatePayload) => void;
  'note-typing': (payload: NoteTypingPayload) => void;
}

export interface ServerToClientEvents {
  'room-created': (payload: RoomCreatedPayload) => void;
  'join-request': (payload: JoinRequestPayload) => void;
  'join-approved': (payload: JoinApprovedPayload) => void;
  'join-rejected': (payload: JoinRejectedPayload) => void;
  'user-joined': (payload: UserJoinedPayload) => void;
  'user-left': (payload: UserLeftPayload) => void;
  'room-closed': (payload: RoomClosedPayload) => void;
  'signal-offer': (payload: SignalOfferPayload) => void;
  'signal-answer': (payload: SignalAnswerPayload) => void;
  'signal-ice-candidate': (payload: SignalIceCandidatePayload) => void;
  'edit-patch': (payload: EditPatchRelayPayload) => void;
  'cursor-update': (payload: CursorUpdateRelayPayload) => void;
  'file-tree': (payload: FileTreePayload) => void;
  'file-activity': (payload: FileActivityPayload) => void;
  'note-update': (payload: NoteUpdatePayload) => void;
  'note-typing': (payload: NoteTypingPayload) => void;
  error: (payload: ErrorPayload) => void;
}
