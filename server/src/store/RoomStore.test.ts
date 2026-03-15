import { describe, it, expect, afterEach } from 'vitest';
import { RoomStore } from './RoomStore';

describe('RoomStore', () => {
  let store: RoomStore;

  afterEach(() => {
    store?.destroy();
  });

  it('should create a room', () => {
    store = new RoomStore(999_999);
    const room = store.create('test-room', 'host-1', '$2b$12$hash', 'workspace');
    expect(room.id).toBe('test-room');
    expect(room.hostSocketId).toBe('host-1');
    expect(room.members).toEqual(['host-1']);
    expect(store.size).toBe(1);
  });

  it('should add and remove members', () => {
    store = new RoomStore(999_999);
    store.create('room-1', 'host-1', '$2b$12$hash', 'workspace');
    store.addMember('room-1', 'guest-1');
    store.addMember('room-1', 'guest-2');

    const room = store.get('room-1')!;
    expect(room.members).toEqual(['host-1', 'guest-1', 'guest-2']);

    store.removeMember('room-1', 'guest-1');
    expect(room.members).toEqual(['host-1', 'guest-2']);
  });

  it('should find rooms by socket', () => {
    store = new RoomStore(999_999);
    store.create('room-a', 'host-1', 'hash', 'file');
    store.create('room-b', 'host-2', 'hash', 'folder');
    store.addMember('room-b', 'host-1');

    const rooms = store.getRoomsBySocket('host-1');
    expect(rooms).toHaveLength(2);
  });

  it('should delete a room', () => {
    store = new RoomStore(999_999);
    store.create('room-x', 'host-1', 'hash', 'workspace');
    expect(store.delete('room-x')).toBe(true);
    expect(store.get('room-x')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('should assign deterministic colors', () => {
    store = new RoomStore(999_999);
    store.create('room-c', 'host-1', 'hash', 'workspace');
    store.addMember('room-c', 'guest-1');

    const color1 = store.getMemberColor('room-c', 'host-1');
    const color2 = store.getMemberColor('room-c', 'guest-1');
    expect(color1).not.toBe(color2);

    // Same call should return same color (deterministic)
    expect(store.getMemberColor('room-c', 'host-1')).toBe(color1);
  });
});
