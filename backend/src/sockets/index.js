const { Server } = require('socket.io');
const { socketAuthMiddleware } = require('../middleware/auth');
const { createIoredisPairIfConfigured } = require('../utils/redis');
const registerGameHandlers = require('./gameHandlers');
const registerUserHandlers = require('./userHandlers');
const logger = require('../utils/logger');

/**
 * Attaches Socket.IO to the shared HTTP server. Every client-to-server
 * event requires a valid JWT in the handshake auth object (§2.3/§10.1) —
 * there is no unauthenticated path into any game room.
 */
function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET', 'POST'] }
  });

  const ioredisPair = createIoredisPairIfConfigured();
  if (ioredisPair) {
    try {
      // eslint-disable-next-line global-require
      const { createAdapter } = require('@socket.io/redis-adapter');
      io.adapter(createAdapter(ioredisPair.pubClient, ioredisPair.subClient));
      logger.info('Socket.IO Redis adapter attached (multi-instance mode)');
    } catch (err) {
      logger.warn('Socket.IO Redis adapter unavailable, continuing single-instance', { error: err.message });
    }
  }

  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    logger.info('Socket connected', { userId: socket.userId });
    socket.join(`user:${socket.userId}`);

    registerGameHandlers(io, socket);
    registerUserHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      logger.info('Socket disconnected', { userId: socket.userId, reason });
    });
  });

  return io;
}

module.exports = { initSocketServer };
