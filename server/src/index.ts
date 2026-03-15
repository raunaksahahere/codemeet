import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { registerRoomsNamespace } from './namespaces/rooms.js';
import { registerSignalNamespace } from './namespaces/signal.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Register Socket.IO namespaces
registerRoomsNamespace(io);
registerSignalNamespace(io);

httpServer.listen(PORT, () => {
  console.log(`[CodeMeet] Signaling server listening on http://localhost:${PORT}`);
  console.log(`[CodeMeet] Health check: http://localhost:${PORT}/health`);
});
