const mongoose = require('mongoose');
const { Cartela, GameCartela, Game, User, Transaction } = require('../models');
const { ApiError } = require('../middleware/errorHandler');
const walletService = require('./walletService');
const logger = require('../utils/logger');

const MAX_PER_USER = Number(process.env.MAX_CARTELAS_PER_USER || 2);

/**
 * Pre-seeds a GameCartela document for every cartelaId (1-600) the moment a
 * game is created (§6.4/§10.4). This is what makes the atomic
 * findOneAndUpdate({gameId, cartelaId, ownerId: null}, ...) allocation
 * pattern work: without a pre-existing document, "not found" and "already
 * taken" would be indistinguishable to the caller.
 *
 * Globally-reserved cartelaIds (Cartela.isReserved) are pre-seeded already
 * claimed by 'system-admin' so they're disabled from the very first render
 * of the selection screen, matching "never available to regular players".
 */
async function createGameCartelaPool(gameId) {
  const allTemplates = await Cartela.find({}, { cartelaId: 1, isReserved: 1 }).lean();
  if (allTemplates.length === 0) {
    throw new Error('No cartela templates found — run `npm run import:cartelas` first.');
  }

  const docs = allTemplates.map((t) => ({
    gameId,
    cartelaId: t.cartelaId,
    ownerId: t.isReserved ? 'system-admin' : null,
    isReserved: !!t.isReserved,
    purchasedAt: t.isReserved ? new Date() : null
  }));

  try {
    await GameCartela.insertMany(docs, { ordered: false });
  } catch (err) {
    // Retrying pool-creation for an already-seeded gameId (crash recovery)
    // hits duplicate-key errors, which are safe to ignore — but a bulk
    // insertMany error doesn't reliably expose a single top-level
    // `err.code` across driver versions, so check every individual write
    // error rather than trusting one field.
    const writeErrors = err.writeErrors || (err.code ? [err] : []);
    const allDuplicates = writeErrors.length > 0 && writeErrors.every((e) => (e.code || (e.err && e.err.code)) === 11000);
    if (!allDuplicates) {
      logger.error('createGameCartelaPool insertMany failed', { gameId, error: err.message });
      throw err;
    }
  }
  return docs.length;
}

async function listAvailableCartelas(gameId) {
  const available = await GameCartela.find({ gameId, ownerId: null }, { cartelaId: 1 }).lean();
  return available.map((d) => d.cartelaId).sort((a, b) => a - b);
}

async function countSold(gameId) {
  const [real, admin] = await Promise.all([
    // NOTE: this must be $nin: [null, 'system-admin'] as ONE operator.
    // { $ne: null, $ne: 'system-admin' } is a JS object literal with a
    // duplicate key — JS silently keeps only the last one, so that query
    // actually ran as { $ne: 'system-admin' }, which counts every
    // *unclaimed* (ownerId: null) cartela as if it were a real sale. That
    // made the engine believe the minimum was already met from the moment
    // each game's pool was seeded, so auto-allocation never fired.
    GameCartela.countDocuments({ gameId, ownerId: { $nin: [null, 'system-admin'] } }),
    GameCartela.countDocuments({ gameId, ownerId: 'system-admin' })
  ]);
  return { real, admin, total: real + admin };
}

/** Joins GameCartela ownership with the immutable grid template, for winner detection. */
async function getGameCartelasWithGrids(gameId) {
  const owned = await GameCartela.find({ gameId, ownerId: { $ne: null } }, { cartelaId: 1, ownerId: 1 }).lean();
  if (owned.length === 0) return [];
  const cartelaIds = owned.map((o) => o.cartelaId);
  const templates = await Cartela.find({ cartelaId: { $in: cartelaIds } }, { cartelaId: 1, grid: 1 }).lean();
  const gridById = new Map(templates.map((t) => [t.cartelaId, t.grid]));
  return owned.map((o) => ({ cartelaId: o.cartelaId, ownerId: o.ownerId, grid: gridById.get(o.cartelaId) }));
}

/**
 * Atomically claims a single cartela for `ownerId` within `gameId`.
 * Returns the updated document, or null if it was already taken.
 */
async function claimCartela(gameId, cartelaId, ownerId, session) {
  return GameCartela.findOneAndUpdate(
    { gameId, cartelaId, ownerId: null },
    { ownerId, purchasedAt: new Date() },
    { new: true, session }
  );
}

/**
 * Real-player purchase (§4.6/§6.4/§7.3). Idempotent: a cartelaId already
 * owned by the SAME requesting user is treated as already-purchased rather
 * than an error, so a client retry after a dropped response doesn't fail.
 */
async function purchaseCartelas(gameId, userId, cartelaIds) {
  const uniqueIds = [...new Set(cartelaIds)];
  if (uniqueIds.length === 0) throw new ApiError(400, 'INVALID_AMOUNT', 'No cartelas selected.');

  const game = await Game.findOne({ gameId });
  if (!game || game.status !== 'WAITING') {
    throw new ApiError(409, 'CARTELA_UNAVAILABLE', 'This game is no longer accepting cartela selections.');
  }

  const existingForUser = await GameCartela.countDocuments({ gameId, ownerId: String(userId) });
  if (existingForUser + uniqueIds.length > MAX_PER_USER) {
    throw new ApiError(400, 'INVALID_AMOUNT', `Maximum ${MAX_PER_USER} cartelas per user per game.`);
  }

  const session = await mongoose.startSession();
  const purchased = [];
  const alreadyOwnedByUser = [];
  let totalCost = 0;

  try {
    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

      const toCharge = [];
      for (const cartelaId of uniqueIds) {
        const claimed = await claimCartela(gameId, cartelaId, String(userId), session);
        if (claimed) {
          toCharge.push(cartelaId);
          purchased.push(cartelaId);
        } else {
          const existing = await GameCartela.findOne({ gameId, cartelaId }).session(session);
          if (existing && existing.ownerId === String(userId)) {
            alreadyOwnedByUser.push(cartelaId); // idempotent no-op
          } else {
            throw new ApiError(409, 'CARTELA_UNAVAILABLE', `Cartela #${cartelaId} is no longer available.`);
          }
        }
      }

      totalCost = toCharge.length * game.stake;
      if (totalCost > 0) {
        if (user.mainWalletBalance < totalCost) {
          throw new ApiError(400, 'INSUFFICIENT_BALANCE', 'Insufficient balance to purchase cartela(s).', {
            required: totalCost,
            available: user.mainWalletBalance
          });
        }
        user.mainWalletBalance -= totalCost;
        await user.save({ session });

        // Pass `session` so the reference-id counter increments atomically
        // with this transaction (commits/rolls back together) instead of as
        // an independent side effect that could outlive a retried/aborted
        // purchase attempt.
        const referenceId = await walletService.nextReferenceId(session);
        await Transaction.create(
          [{
            userId,
            type: 'GAME_PURCHASE',
            amount: totalCost,
            referenceId,
            gameId,
            cartelaIds: toCharge,
            status: 'COMPLETED',
            description: `Purchased ${toCharge.length} cartela(s) for game ${gameId}`
          }],
          { session }
        );

        // ROOT CAUSE FIX (prize pool race condition): `game` was read into
        // memory once, *before* this transaction even started (see the
        // `Game.findOne({ gameId })` above, outside `session.withTransaction`).
        // The old code did `game.grossPrizePool = (game.grossPrizePool||0) + totalCost`
        // on that stale in-memory copy and then `game.save({session})`, which
        // persists an absolute value derived from a value that may already be
        // out of date. When two players purchase cartelas around the same
        // moment (routine during the 45s WAITING window with multiple
        // players), both requests read the same starting grossPrizePool,
        // both compute "old + their own cost", and whichever save() commits
        // last silently overwrites the other's contribution — a classic
        // lost-update. This under-counts the real money collected for the
        // round, so settleGame() later computes commission/netPrizePool off
        // a grossPrizePool that's smaller than stake x real players, and
        // winners are paid less than they should be. It reproduces
        // intermittently (matches "sometimes erroneous") because it only
        // triggers when purchases overlap in time.
        //
        // Fix: never read-modify-write a shared counter across a network
        // round trip. Use MongoDB's atomic $inc directly, in the same
        // session/transaction as the wallet debit and transaction record,
        // so the increment always applies against the row's current
        // database value regardless of concurrent purchases.
        await Game.updateOne(
          { gameId },
          { $inc: { grossPrizePool: totalCost } },
          { session }
        );
      }
    });
  } finally {
    session.endSession();
  }

  const user = await User.findById(userId);
  return {
    purchased: [...purchased, ...alreadyOwnedByUser],
    totalCost,
    newBalance: user.mainWalletBalance
  };
}

/** A single user's owned cartelas (with grids) within a game — powers the live gameplay screen. */
async function getUserCartelas(gameId, userId) {
  const owned = await GameCartela.find({ gameId, ownerId: String(userId) }, { cartelaId: 1, isWinner: 1 }).lean();
  if (owned.length === 0) return [];
  const cartelaIds = owned.map((o) => o.cartelaId);
  const templates = await Cartela.find({ cartelaId: { $in: cartelaIds } }, { cartelaId: 1, grid: 1 }).lean();
  const gridById = new Map(templates.map((t) => [t.cartelaId, t.grid]));
  return owned.map((o) => ({ cartelaId: o.cartelaId, grid: gridById.get(o.cartelaId), isWinner: o.isWinner }));
}

module.exports = {
  MAX_PER_USER,
  createGameCartelaPool,
  listAvailableCartelas,
  countSold,
  getGameCartelasWithGrids,
  getUserCartelas,
  claimCartela,
  purchaseCartelas
};
