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
  passwordHash: string;
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

// ── Cursor sync events (sent over DataChannel) ──

export interface CursorUpdatePayload {
  file: string;
  line: number;
  character: number;
  userId: string;
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
  error: (payload: ErrorPayload) => void;
}
