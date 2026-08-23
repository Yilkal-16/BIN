const express = require('express');
const { Game } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ok, fail, paginationParams, asyncHandler } = require('../utils/helpers');
const cartelaService = require('../services/cartelaService');

const router = express.Router();
router.use(requireAuth);

async function currentGameState() {
  const game = await Game.findOne({ status: { $in: ['WAITING', 'ACTIVE', 'SETTLING'] } }).sort({ startTime: -1 });
  if (!game) return null;
  const { real, admin, total } = await cartelaService.countSold(game.gameId);
  return {
    gameId: game.gameId,
    status: game.status,
    stake: game.stake,
    playersCount: real,
    totalCartelas: total,
    adminCartelas: admin,
    currentDrawIndex: game.currentDrawIndex,
    prizePool: game.prizePool ?? null,
    grossPrizePool: game.grossPrizePool ?? 0
  };
}

// Single stake tier for v1 (§4.5) — `stake` is accepted for forward
// compatibility with the documented API shape but there is only one active
// game at a time regardless of its value.
router.get('/lobby', asyncHandler(async (req, res) => {
  const gameState = await currentGameState();
  if (!gameState) return fail(res, 404, 'NOT_FOUND', 'No active game right now — one starts automatically within moments.');
  return ok(res, { gameState });
}));

router.post('/stake', asyncHandler(async (req, res) => {
  const gameState = await currentGameState();
  if (!gameState) return fail(res, 404, 'NOT_FOUND', 'No active game right now.');
  return ok(res, { gameId: gameState.gameId });
}));

router.get('/state', asyncHandler(async (req, res) => {
  const { gameId } = req.query;
  const game = gameId ? await Game.findOne({ gameId }) : null;
  if (!game) return fail(res, 404, 'NOT_FOUND', 'Game not found');
  const { real, admin, total } = await cartelaService.countSold(game.gameId);
  return ok(res, {
    gameState: {
      gameId: game.gameId,
      status: game.status,
      stake: game.stake,
      playersCount: real,
      totalCartelas: total,
      adminCartelas: admin,
      currentDrawIndex: game.currentDrawIndex,
      prizePool: game.prizePool ?? null,
      grossPrizePool: game.grossPrizePool ?? 0,
      winners: game.winners,
      noWinner: game.noWinner
    }
  });
}));

router.get('/history', asyncHandler(async (req, res) => {
  const { limit, offset } = paginationParams(req.query);
  const filter = { status: 'COMPLETED' };
  const [games, total] = await Promise.all([
    Game.find(filter).sort({ startTime: -1 }).skip(offset).limit(limit),
    Game.countDocuments(filter)
  ]);
  return ok(res, {
    games: games.map((g) => ({
      gameId: g.gameId,
      stake: g.stake,
      startTime: g.startTime,
      endTime: g.endTime,
      prizePool: g.prizePool,
      winners: g.winners,
      noWinner: g.noWinner
    })),
    pagination: { limit, offset, total, hasMore: offset + games.length < total }
  });
}));

module.exports = router;
