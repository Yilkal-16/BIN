const { Game, DrawSequence } = require('../models');
const { generateGameId, getMinCartelasForStake } = require('../utils/helpers');
const { getNextSequence } = require('../models/Counter');
const { shuffle } = require('../utils/helpers');
const cartelaService = require('../services/cartelaService');
const logger = require('../utils/logger');

const STAKE = Number(process.env.STAKE_AMOUNT || 10);

/** Ensures at least 2 unused draw sequences exist, generating a batch of 12 if not (§6.2). */
async function ensureDrawSequences() {
  const unused = await DrawSequence.countDocuments({ used: false });
  if (unused >= 2) return;
  const batch = [];
  for (let i = 0; i < 12; i++) {
    batch.push({ numbers: shuffle(Array.from({ length: 75 }, (_, i2) => i2 + 1)), used: false });
  }
  await DrawSequence.insertMany(batch);
  logger.info('Generated a new batch of 12 draw sequences');
}

async function claimDrawSequence(gameId) {
  await ensureDrawSequences();
  const seq = await DrawSequence.findOneAndUpdate(
    { used: false },
    { used: true, usedAt: new Date(), gameId },
    { new: true, sort: { createdAt: 1 } }
  );
  if (!seq) throw new Error('No draw sequence available — this should not happen after ensureDrawSequences()');
  return seq;
}

/**
 * Creates a brand-new WAITING game: reserves a gameId, claims a draw
 * sequence, and pre-seeds the 600-cartela GameCartela pool (§6.4).
 */
async function createNewGame(rolloverFromGameId = null) {
  const today = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const seq = await getNextSequence(`gameId:${today}`);
  const gameId = generateGameId(seq);

  const drawSequence = await claimDrawSequence(gameId);

  let rolloverAmount = 0;
  if (rolloverFromGameId) {
    const sourceGame = await Game.findOne({ gameId: rolloverFromGameId });
    if (sourceGame && sourceGame.noWinner) rolloverAmount = sourceGame.grossPrizePool || 0;
  }

  const game = await Game.create({
    gameId,
    stake: STAKE,
    drawSequenceId: drawSequence._id,
    status: 'WAITING',
    currentDrawIndex: 0,
    startTime: new Date(),
    grossPrizePool: rolloverAmount,
    rolloverFromGameId,
    version: 0
  });

  await cartelaService.createGameCartelaPool(gameId);
  logger.info('Created new game', { gameId, rolloverFromGameId, rolloverAmount });
  return game;
}

/** Atomic, version-guarded transition. Returns the updated doc, or null if the precondition failed. */
async function transitionState(gameId, fromStatus, toStatus, extraSet = {}) {
  const game = await Game.findOne({ gameId });
  if (!game) return null;
  const updated = await Game.findOneAndUpdate(
    { gameId, status: fromStatus, version: game.version },
    { $set: { status: toStatus, ...extraSet }, $inc: { version: 1 } },
    { new: true }
  );
  if (!updated) {
    logger.warn('State transition precondition failed (concurrent writer?)', { gameId, fromStatus, toStatus });
  }
  return updated;
}

function minCartelasForCurrentStake() {
  return getMinCartelasForStake(STAKE);
}

module.exports = {
  STAKE,
  ensureDrawSequences,
  claimDrawSequence,
  createNewGame,
  transitionState,
  minCartelasForCurrentStake
};
