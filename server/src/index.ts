import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { registerRoomsNamespace } from './namespaces/rooms.js';
import { registerSignalNamespace } from './namespaces/signal.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting: 100 requests per 15 minutes per IP
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  }),
);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    version: '0.1.0',
  });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Limit payload size for security
  maxHttpBufferSize: 1e6, // 1 MB
});

// Register Socket.IO namespaces
registerRoomsNamespace(io);
registerSignalNamespace(io);

httpServer.listen(PORT, () => {
  console.log(`[CodeMeet] Signaling server listening on http://localhost:${PORT}`);
  console.log(`[CodeMeet] Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`\n[CodeMeet] Received ${signal}, shutting down gracefully...`);
  io.close(() => {
    httpServer.close(() => {
      console.log('[CodeMeet] Server closed.');
      process.exit(0);
    });
  });
  // Force exit after 5s if graceful shutdown fails
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
