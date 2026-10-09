const express = require('express');
const { Game } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ok, fail, paginationParams, asyncHandler, STAKES, DEFAULT_STAKE } = require('../utils/helpers');
const cartelaService = require('../services/cartelaService');

const router = express.Router();
router.use(requireAuth);

function parseStake(raw) {
  const stake = Number(raw ?? DEFAULT_STAKE);
  return STAKES.includes(stake) ? stake : null;
}

async function currentGameState(stake) {
  const game = await Game.findOne({ stake, status: { $in: ['WAITING', 'ACTIVE', 'SETTLING'] } }).sort({ startTime: -1 });
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

// Multiple stake tiers (§4.5) run independently and concurrently — `stake`
// selects which tier's current game to return.
router.get('/lobby', asyncHandler(async (req, res) => {
  const stake = parseStake(req.query.stake);
  if (stake === null) return fail(res, 400, 'INVALID_AMOUNT', `stake must be one of ${STAKES.join(', ')}`);
  const gameState = await currentGameState(stake);
  if (!gameState) return fail(res, 404, 'NOT_FOUND', 'No active game right now — one starts automatically within moments.');
  return ok(res, { gameState });
}));

router.get('/stakes', asyncHandler(async (req, res) => {
  return ok(res, { stakes: STAKES });
}));

router.post('/stake', asyncHandler(async (req, res) => {
  const stake = parseStake(req.body && req.body.stake);
  if (stake === null) return fail(res, 400, 'INVALID_AMOUNT', `stake must be one of ${STAKES.join(', ')}`);
  const gameState = await currentGameState(stake);
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
  const stake = req.query.stake !== undefined ? parseStake(req.query.stake) : undefined;
  if (stake === null) return fail(res, 400, 'INVALID_AMOUNT', `stake must be one of ${STAKES.join(', ')}`);
  if (stake !== undefined) filter.stake = stake;

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
