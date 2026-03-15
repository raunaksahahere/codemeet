// @codemeet/shared — barrel export
export type {
  PatchRange,
  EditPatch,
} from './types/patches.js';

export type {
  RoomScope,
  Room,
  RoomMember,
} from './types/room.js';

export type {
  CreateRoomPayload,
  JoinRoomPayload,
  JoinResponsePayload,
  RoomCreatedPayload,
  JoinRequestPayload,
  JoinApprovedPayload,
  JoinRejectedPayload,
  UserJoinedPayload,
  UserLeftPayload,
  RoomClosedPayload,
  ErrorPayload,
  SdpPayload,
  IceCandidatePayload,
  SignalOfferPayload,
  SignalAnswerPayload,
  SignalIceCandidatePayload,
  CursorUpdatePayload,
  EditPatchRelayPayload,
  CursorUpdateRelayPayload,
  FileTreeEntry,
  FileTreePayload,
  FileActivityPayload,
  ClientToServerEvents,
  ServerToClientEvents,
} from './types/events.js';
