process.env.MONGODB_URI = 'mongodb://stub/test';

const { Cartela, Game, User } = require('../src/models');
const cartelaService = require('../src/services/cartelaService');
const { ensureHouseUser, ensureHouseWallet } = require('../src/utils/bootstrap');

function dummyGrid(seed) {
  const base = seed * 1000;
  const g = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) row.push(r === 2 && c === 2 ? null : base + r * 5 + c);
    g.push(row);
  }
  return g;
}

describe('countSold (regression: unclaimed cartelas must NOT count as real sales)', () => {
  test('a freshly-seeded pool with zero purchases reports real=0, not real=~600', async () => {
    for (let i = 1; i <= 5; i++) {
      await Cartela.create({ cartelaId: 9000 + i, grid: dummyGrid(i), isReserved: false });
    }
    const game = await Game.create({ gameId: 'REGRESSION-1', stake: 10, status: 'WAITING', grossPrizePool: 0, version: 0 });
    await cartelaService.createGameCartelaPool(game.gameId);

    const { real, admin, total } = await cartelaService.countSold(game.gameId);

    // This is the exact bug: { $ne: null, $ne: 'system-admin' } is a JS
    // object literal with a duplicate key, which silently collapses to
    // { $ne: 'system-admin' } — counting every unclaimed cartela as "real".
    expect(real).toBe(0);
    expect(admin).toBe(0);
    expect(total).toBe(0);
  });

  test('one real purchase is counted as real=1, unclaimed cartelas are not', async () => {
    for (let i = 1; i <= 5; i++) {
      await Cartela.create({ cartelaId: 9100 + i, grid: dummyGrid(i), isReserved: false });
    }
    const game = await Game.create({ gameId: 'REGRESSION-2', stake: 10, status: 'WAITING', grossPrizePool: 0, version: 0 });
    await cartelaService.createGameCartelaPool(game.gameId);
    const buyer = await User.create({ telegramId: 'reg2', phone: 'reg2phone', displayName: 'Regression Buyer', mainWalletBalance: 100 });
    await cartelaService.purchaseCartelas(game.gameId, buyer._id, [9101]);

    const { real, admin, total } = await cartelaService.countSold(game.gameId);
    expect(real).toBe(1);
    expect(admin).toBe(0);
    expect(total).toBe(1);
  });

  test('admin-allocated cartelas count as admin, not real, and unclaimed ones still count as neither', async () => {
    await ensureHouseUser();
    const wallet = await ensureHouseWallet();
    if (wallet.balance < 100) {
      const { HouseWallet } = require('../src/models');
      await HouseWallet.updateOne({ walletId: 'house' }, { $set: { balance: 1000 } });
    }

    for (let i = 1; i <= 10; i++) {
      await Cartela.create({ cartelaId: 9200 + i, grid: dummyGrid(i), isReserved: false });
    }
    const game = await Game.create({ gameId: 'REGRESSION-3', stake: 10, status: 'WAITING', grossPrizePool: 0, version: 0 });
    await cartelaService.createGameCartelaPool(game.gameId);
    const buyer = await User.create({ telegramId: 'reg3', phone: 'reg3phone', displayName: 'Regression Buyer 3', mainWalletBalance: 100 });
    await cartelaService.purchaseCartelas(game.gameId, buyer._id, [9201]);
    await cartelaService.allocateToSystemAdmin(game.gameId, 3);

    const { real, admin, total } = await cartelaService.countSold(game.gameId);
    expect(real).toBe(1);
    expect(admin).toBe(3);
    expect(total).toBe(4); // NOT 10 — the other 6 are still unclaimed
  });
});
