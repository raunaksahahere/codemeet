export * from './session.js';
export * from './docsync.js';
export * from './workspace.js';

import { SharingPolicy, type RoomInfo } from '@codemeet/shared';
/** Builds the local copy of the room's sharing policy from the server-provided room info. */
export function policyFromRoom(room: RoomInfo): SharingPolicy {
  return new SharingPolicy({ scope: room.scope, scopePath: room.scopePath ?? undefined, codeignore: room.codeignore });
}
