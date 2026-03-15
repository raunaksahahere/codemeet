/** Map of socketId → displayName, tracked per namespace connection. */
const socketNames = new Map<string, string>();

export function setDisplayName(socketId: string, name: string): void {
  socketNames.set(socketId, name);
}

export function getDisplayName(socketId: string): string {
  return socketNames.get(socketId) ?? 'Anonymous';
}

export function removeDisplayName(socketId: string): void {
  socketNames.delete(socketId);
}
