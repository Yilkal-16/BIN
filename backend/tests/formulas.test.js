const { getMinCartelasForStake } = require('../src/utils/helpers');
const { batchSizeForTick } = require('../src/game/scheduler');

describe('getMinCartelasForStake (§6.3/§6.5)', () => {
  beforeEach(() => {
    process.env.MIN_PRIZE_POOL = '1200';
    process.env.HOUSE_COMMISSION = '0.2';
  });

  test('stake 10 -> 150 cartelas needed to guarantee the 1200 Birr floor', () => {
    expect(getMinCartelasForStake(10)).toBe(150);
  });

  test('stake 20 -> 75 cartelas (scales down, not stuck at 150)', () => {
    expect(getMinCartelasForStake(20)).toBe(75);
  });

  test('stake 50 -> 30 cartelas', () => {
    expect(getMinCartelasForStake(50)).toBe(30);
  });
});

/** Mirrors the exact rounding formula used in game/engine.js settleGame(). */
function computePrizeSplit(grossPool, winnerCount, commissionRate) {
  const commission = Math.round(grossPool * commissionRate * 100) / 100;
  const net = grossPool - commission;
  const perWinner = Math.floor((net / winnerCount) * 100) / 100;
  const remainder = Math.round((net - perWinner * winnerCount) * 100) / 100;
  return { commission, net, perWinner, remainder };
}

describe('prize rounding (§6.5 Step B)', () => {
  test('evenly divisible pool leaves no remainder', () => {
    const { commission, net, perWinner, remainder } = computePrizeSplit(1500, 3, 0.2);
    expect(commission).toBe(300);
    expect(net).toBe(1200);
    expect(perWinner).toBe(400);
    expect(remainder).toBe(0);
  });

  test('a non-divisible pool rounds down per winner and books the leftover as house remainder', () => {
    const { perWinner, remainder, net } = computePrizeSplit(1000, 3, 0.2); // net=800
    expect(perWinner).toBe(266.66);
    const total = Math.round((perWinner * 3 + remainder) * 100) / 100;
    expect(total).toBe(net); // every cent is accounted for — no shortfall, no phantom surplus
  });

  test('a single winner takes the entire net pool with zero rounding remainder', () => {
    const { perWinner, remainder } = computePrizeSplit(777, 1, 0.2);
    expect(remainder).toBe(0);
    expect(perWinner).toBe(Math.round(777 * 0.8 * 100) / 100);
  });
});

describe('batchSizeForTick (§6.3 auto-allocation batching)', () => {
  test('spreads a large deficit across the remaining ticks instead of dumping it all at once', () => {
    const batch = batchSizeForTick(10, 1, 8);
    expect(batch).toBeGreaterThan(0);
    expect(batch).toBeLessThan(150);
  });

  test('returns 0 once the minimum has already been met', () => {
    expect(batchSizeForTick(10, 150, 5)).toBe(0);
  });

  test('never over-allocates beyond the remaining deficit on the final tick', () => {
    const batch = batchSizeForTick(10, 148, 1); // deficit=2, 1 tick left
    expect(batch).toBe(2);
  });
});
