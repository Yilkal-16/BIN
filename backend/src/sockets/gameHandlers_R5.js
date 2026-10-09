const { Game } = require('../models');
const cartelaService = require('../services/cartelaService');
const logger = require('../utils/logger');

async function sendFullState(socket, gameId) {
  const game = await Game.findOne({ gameId });
  if (!game) return;
  const { real, admin, total } = await cartelaService.countSold(gameId);
  socket.emit('game_state_update', {
    gameId: game.gameId,
    status: game.status,
    stake: game.stake,
    playersCount: real,
    totalCartelas: total,
    adminCartelas: admin,
    currentDrawIndex: game.currentDrawIndex,
    prizePool: game.prizePool ?? null,
    grossPrizePool: game.grossPrizePool ?? 0
  });
}

function registerGameHandlers(io, socket) {
  socket.on('join_game', async ({ gameId }) => {
    if (!gameId) return;
    socket.join(`game:${gameId}`);
    socket.currentGameId = gameId;
    logger.info('Socket joined game room', { userId: socket.userId, gameId });
    await sendFullState(socket, gameId);
  });

  socket.on('leave_game', ({ gameId }) => {
    if (gameId) socket.leave(`game:${gameId}`);
    socket.currentGameId = null;
  });

  // Lightweight presence signal only — the real, money-moving purchase goes
  // through POST /api/cartela/purchase (§8.6), which itself broadcasts the
  // persisted cartela_update once the atomic purchase succeeds. This event
  // just lets other players see "someone is looking at this cartela" live.
  socket.on('select_cartela', ({ gameId, cartelaId }) => {
    if (!gameId || !cartelaId) return;
    socket.to(`game:${gameId}`).emit('cartela_update', {
      gameId,
      cartelaId,
      status: 'previewing',
      ownerId: null
    });
  });

  // Auto-daubing is purely a client-side animation preference — the server
  // already marks every cartela automatically regardless (§4.7 Step 3) and
  // winner detection never requires a manual claim (§6.6). Just ack it.
  socket.on('toggle_auto_mode', (payload, ack) => {
    if (typeof ack === 'function') ack({ ok: true, autoMode: !!(payload && payload.enabled) });
  });

  socket.on('refresh_state', async ({ gameId } = {}) => {
    await sendFullState(socket, gameId || socket.currentGameId);
  });
}

module.exports = registerGameHandlers;
