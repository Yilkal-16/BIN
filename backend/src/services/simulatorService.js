const { Cartela, DrawSequence } = require('../models');
const { checkAllPatterns } = require('../game/winnerDetection');
const logger = require('../utils/logger');

// The supplied production dataset is the 200-card master set used for the
// simulator. Keep this explicit so a future accidental import of a 600-card
// archive cannot silently change the prediction set.
const SIMULATOR_CARTELA_COUNT = 200;
const PREDICTION_VERSION = 1;

function validateGrid(grid, cartelaId) {
  if (
    !Array.isArray(grid) ||
    grid.length !== 5 ||
    grid.some((row) => !Array.isArray(row) || row.length !== 5)
  ) {
    throw new Error(`Cartela #${cartelaId} does not have a valid 5x5 grid.`);
  }
}

async function loadSimulatorCartelas() {
  const cartelas = await Cartela.find({})
    .sort({ cartelaId: 1 })
    .limit(SIMULATOR_CARTELA_COUNT)
    .lean();

  if (cartelas.length !== SIMULATOR_CARTELA_COUNT) {
    throw new Error(
      `Simulator requires exactly ${SIMULATOR_CARTELA_COUNT} cartela templates; ` +
      `found ${cartelas.length}. Import data/cartelas.csv first.`
    );
  }

  for (const cartela of cartelas) validateGrid(cartela.grid, cartela.cartelaId);
  return cartelas;
}

/**
 * Determines the first three cartelas, among the 200 simulator templates,
 * that complete any configured winning pattern for this exact draw order.
 * Ties at the same draw are resolved by ascending cartelaId, making the
 * prediction deterministic and reproducible.
 */
function simulateTopThree(numbers, cartelas) {
  if (!Array.isArray(numbers) || numbers.length !== 75) {
    throw new Error('A DrawSequence must contain exactly 75 numbers.');
  }

  const drawn = new Set();
  const pending = new Set(cartelas.map((c) => c.cartelaId));
  const winners = [];
  const cartelaById = new Map(cartelas.map((c) => [c.cartelaId, c]));

  for (let drawIndex = 0; drawIndex < numbers.length && winners.length < 3; drawIndex += 1) {
    const drawNumber = Number(numbers[drawIndex]);
    drawn.add(drawNumber);

    const completedThisDraw = [];

    for (const cartelaId of pending) {
      const cartela = cartelaById.get(cartelaId);
      const patterns = checkAllPatterns(cartela.grid, drawn);
      if (patterns.length > 0) {
        completedThisDraw.push({
          cartelaId,
          drawIndex: drawIndex + 1,
          drawNumber,
          patterns
        });
      }
    }

    completedThisDraw.sort((a, b) => a.cartelaId - b.cartelaId);

    for (const winner of completedThisDraw) {
      pending.delete(winner.cartelaId);
      winners.push({
        rank: winners.length + 1,
        ...winner
      });
      if (winners.length >= 3) break;
    }
  }

  return winners;
}

async function predictSequence(sequence, cartelas) {
  const predictedWinners = simulateTopThree(sequence.numbers, cartelas);
  return {
    predictedWinners,
    predictionVersion: PREDICTION_VERSION,
    predictedAt: new Date()
  };
}

async function generatePredictionsForSequences(sequences, cartelas = null) {
  if (!sequences.length) return [];

  const templates = cartelas || await loadSimulatorCartelas();
  const operations = [];
  const results = [];

  for (const sequence of sequences) {
    const prediction = await predictSequence(sequence, templates);
    operations.push({
      updateOne: {
        filter: { _id: sequence._id },
        update: { $set: prediction }
      }
    });
    results.push({
      sequenceId: sequence._id,
      ...prediction
    });
  }

  await DrawSequence.bulkWrite(operations, { ordered: true });
  logger.info('Generated simulator predictions', {
    sequences: sequences.length,
    cartelas: templates.length,
    topWinnersPerSequence: 3,
    predictionVersion: PREDICTION_VERSION
  });

  return results;
}

/** Backfills predictions for old DrawSequence documents created before this upgrade. */
async function ensurePredictionsForExistingSequences() {
  const missing = await DrawSequence.find({
    $or: [
      { predictionVersion: { $ne: PREDICTION_VERSION } },
      { predictedWinners: { $exists: false } },
      { 'predictedWinners.2': { $exists: false } }
    ]
  }).sort({ createdAt: 1 });

  if (!missing.length) return 0;
  const cartelas = await loadSimulatorCartelas();
  await generatePredictionsForSequences(missing, cartelas);
  return missing.length;
}

module.exports = {
  SIMULATOR_CARTELA_COUNT,
  PREDICTION_VERSION,
  loadSimulatorCartelas,
  simulateTopThree,
  predictSequence,
  generatePredictionsForSequences,
  ensurePredictionsForExistingSequences
};
