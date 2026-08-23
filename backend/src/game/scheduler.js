const { getMinCartelasForStake } = require('../utils/helpers');

const SELECTION_TIME = Number(process.env.CARTELA_SELECTION_TIME || 45);
const TICK_INTERVAL = 5; // seconds — "checks total sold every 5 seconds" (§6.3)

/**
 * §6.3 says auto-allocation happens "in batches every 5 seconds until total
 * reaches [minCartelas]" but doesn't pin an exact batch size. The simplest
 * reading that actually spreads allocation across the window (rather than
 * instantly dumping the whole deficit into the grid the moment the first
 * real cartela sells) is to divide the deficit evenly across the ticks
 * remaining after the first 5-second check.
 */
function ticksRemainingAfterFirstCheck() {
  return Math.max(1, Math.floor((SELECTION_TIME - TICK_INTERVAL) / TICK_INTERVAL));
}

/**
 * Given the current total sold (real + admin) for a stake, returns how many
 * MORE cartelas should be allocated on this tick.
 */
function batchSizeForTick(stake, currentTotalSold, ticksLeft) {
  const minCartelas = getMinCartelasForStake(stake);
  const deficit = Math.max(0, minCartelas - currentTotalSold);
  if (deficit === 0) return 0;
  const remaining = Math.max(1, ticksLeft);
  return Math.min(deficit, Math.ceil(deficit / remaining));
}

module.exports = { SELECTION_TIME, TICK_INTERVAL, ticksRemainingAfterFirstCheck, batchSizeForTick };
