import { Namespace, Server } from 'socket.io';

/**
 * `/signal` namespace — relays WebRTC offer/answer/ICE candidates.
 * Peers use this to establish a direct P2P DataChannel.
 */
export function registerSignalNamespace(io: Server): Namespace {
  const signal = io.of('/signal');

  signal.on('connection', (socket) => {
    console.log(`[/signal] client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      console.log(`[/signal] client disconnected: ${socket.id}`);
    });
  });

  return signal;
}
