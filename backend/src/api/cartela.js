const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const cartelaService = require('../services/cartelaService');
const notificationService = require('../services/notificationService');

const router = express.Router();
router.use(requireAuth);

router.get('/available', asyncHandler(async (req, res) => {
  const { gameId } = req.query;
  if (!gameId) return fail(res, 400, 'INVALID_AMOUNT', 'gameId is required');
  const cartelas = await cartelaService.listAvailableCartelas(gameId);
  return ok(res, { cartelas, count: cartelas.length });
}));

/**
 * Not explicitly listed in §8.5, but the Live Bingo Screen (§5.4) needs the
 * player's own grid + marked numbers, and no existing endpoint returns
 * that — the simplest solution consistent with §8.5's existing shape.
 */
router.get('/mine', asyncHandler(async (req, res) => {
  const { gameId } = req.query;
  if (!gameId) return fail(res, 400, 'INVALID_AMOUNT', 'gameId is required');
  const cartelas = await cartelaService.getUserCartelas(gameId, req.userId);
  return ok(res, { cartelas });
}));

router.post('/purchase', asyncHandler(async (req, res) => {
  const { cartelaIds, gameId } = req.body || {};
  if (!gameId || !Array.isArray(cartelaIds) || cartelaIds.length === 0) {
    return fail(res, 400, 'INVALID_AMOUNT', 'gameId and a non-empty cartelaIds array are required');
  }

  const result = await cartelaService.purchaseCartelas(gameId, req.userId, cartelaIds.map(Number));

  notificationService.emitToGame(gameId, 'cartela_update', {
    gameId,
    cartelaIds: result.purchased,
    status: 'sold',
    ownerId: req.userId
  });

  return ok(res, result);
}));

module.exports = router;
