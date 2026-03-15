import { Server, Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SignalOfferPayload,
  SignalAnswerPayload,
  SignalIceCandidatePayload,
} from '@codemeet/shared';

type SignalSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

/**
 * `/signal` namespace — relays WebRTC offer/answer/ICE candidates
 * between peers to establish a direct P2P DataChannel.
 */
export function registerSignalNamespace(io: Server): void {
  const signal = io.of('/signal');

  signal.on('connection', (socket: SignalSocket) => {
    console.log(`[/signal] connected: ${socket.id}`);

    socket.on('signal-offer', (payload: SignalOfferPayload) => {
      const target = signal.sockets.get(payload.targetSocketId);
      if (target) {
        target.emit('signal-offer', {
          targetSocketId: socket.id, // sender becomes target for the recipient
          sdp: payload.sdp,
        });
        console.log(`[/signal] offer: ${socket.id} → ${payload.targetSocketId}`);
      }
    });

    socket.on('signal-answer', (payload: SignalAnswerPayload) => {
      const target = signal.sockets.get(payload.targetSocketId);
      if (target) {
        target.emit('signal-answer', {
          targetSocketId: socket.id,
          sdp: payload.sdp,
        });
        console.log(`[/signal] answer: ${socket.id} → ${payload.targetSocketId}`);
      }
    });

    socket.on('signal-ice-candidate', (payload: SignalIceCandidatePayload) => {
      const target = signal.sockets.get(payload.targetSocketId);
      if (target) {
        target.emit('signal-ice-candidate', {
          targetSocketId: socket.id,
          candidate: payload.candidate,
        });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[/signal] disconnected: ${socket.id}`);
    });
  });
}
