const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Game, GameCartela, HouseWallet, HouseSettings, Transaction, User, DrawSequence } = require('../models');
const { Counter } = require('../models/Counter');
const cartelaService = require('./cartelaService');
const walletService = require('./walletService');
const { HOUSE_TELEGRAM_ID } = require('../utils/bootstrap');
const logger = require('../utils/logger');

/* -------------------------------------------------------------------------
 * Admin-controlled settings (Telegram Admin Panel -> AUTO-ALLOCATION)
 * -------------------------------------------------------------------------
 *  - ON/OFF switch: the house never auto-buys anything unless an admin turned
 *    it ON. Default OFF. A change applies from the NEXT selection round (the
 *    settings are read once, when a round starts), so a round already in
 *    progress is never cut short or started late.
 *  - AMOUNT_ADMIN_CARTELAS: how many cartelas the house buys per game. The
 *    env var of the same name is only the starting value used until an admin
 *    saves one in the panel.
 *  - ADMIN-WIN-INTERVAL: every Nth auto-allocated game one of the house's
 *    cartelas is the simulator's rank-1 cartela. 0 = off. The env var
 *    ADMIN_WIN_INTERVAL is only the starting value.
 *
 * While ON, the house buys from the first few seconds of EVERY selection round
 * of every stake (it does not wait for a real player), starting with the very
 * next round after the switch is turned ON. It pauses for a stake only after
 * EMPTY_ROUNDS_TO_PAUSE (3) consecutive rounds of that stake ended with 0 real
 * purchases. While paused, nothing is bought until a real player buys in a
 * round; the house then allocates in that same round, before it goes ACTIVE
 * (before any number is called). Turning the switch OFF takes effect from the
 * next round. A round that ends with 0 real purchases just recycles its countdown.
 * ----------------------------------------------------------------------- */
const MAX_AMOUNT_ADMIN_CARTELAS = 100;
const MAX_ADMIN_WIN_INTERVAL = 100;
const EMPTY_ROUNDS_TO_PAUSE = 3;

function readDefaultAmount() {
  const raw = process.env.AMOUNT_ADMIN_CARTELAS;
  if (raw === undefined || raw === '') return 10;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_AMOUNT_ADMIN_CARTELAS ? n : 10;
}
const DEFAULT_AMOUNT_ADMIN_CARTELAS = readDefaultAmount();

function readDefaultAdminWinInterval() {
  // ADMIN_WIN_INTERVAL is the name now; the old name is still honoured so an existing deployment keeps its value.
  const raw = process.env.ADMIN_WIN_INTERVAL !== undefined && process.env.ADMIN_WIN_INTERVAL !== ''
    ? process.env.ADMIN_WIN_INTERVAL
    : process.env.PREDICTED_WINNER_EVERY_GAMES;
  if (raw === undefined || raw === '') return 4;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ADMIN_WIN_INTERVAL ? n : 4;
}
const DEFAULT_ADMIN_WIN_INTERVAL = readDefaultAdminWinInterval();

async function getAutoAllocationSettings() {
  const doc = await HouseSettings.findById('house').lean();
  const amount = doc && Number.isInteger(doc.amountAdminCartelas) ? doc.amountAdminCartelas : DEFAULT_AMOUNT_ADMIN_CARTELAS;
  // (stored under the field's original name, predictedWinnerEveryGames, so a value already saved keeps working)
  const adminWinInterval = doc && Number.isInteger(doc.predictedWinnerEveryGames)
    ? doc.predictedWinnerEveryGames
    : DEFAULT_ADMIN_WIN_INTERVAL;
  return { enabled: !!(doc && doc.autoAllocateEnabled), amount, adminWinInterval };
}

async function setAutoAllocationEnabled(enabled, adminTelegramId) {
  // Empty rounds only count while the switch is ON, so switching ON starts every
  // stake from a clean slate (an idle spell from before can't leave it paused).
  if (enabled) await Counter.updateMany({ _id: /^emptyStreak:/ }, { $set: { seq: 0 } });
  await HouseSettings.findByIdAndUpdate(
    'house',
    { $set: { autoAllocateEnabled: !!enabled, updatedBy: String(adminTelegramId || ''), updatedAt: new Date() } },
    { upsert: true, new: true }
  );
  logger.info('House auto-allocation switch changed', { enabled: !!enabled, by: String(adminTelegramId || '') });
  return getAutoAllocationSettings();
}

/** Throws an Error with a user-readable message if `value` isn't a whole number in range. */
async function setAmountAdminCartelas(value, adminTelegramId) {
  const blank = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  const n = blank ? NaN : Number(value); // Number('') is 0 — an empty reply must not silently set the amount to 0
  if (!Number.isInteger(n) || n < 0 || n > MAX_AMOUNT_ADMIN_CARTELAS) {
    throw new Error(`Enter a whole number from 0 to ${MAX_AMOUNT_ADMIN_CARTELAS}.`);
  }
  await HouseSettings.findByIdAndUpdate(
    'house',
    { $set: { amountAdminCartelas: n, updatedBy: String(adminTelegramId || ''), updatedAt: new Date() } },
    { upsert: true, new: true }
  );
  logger.info('House auto-allocation amount changed', { amount: n, by: String(adminTelegramId || '') });
  return getAutoAllocationSettings();
}

/** Throws an Error with a user-readable message if `value` isn't a whole number in range. 0 turns the ADMIN-WIN-INTERVAL buy off. */
async function setAdminWinInterval(value, adminTelegramId) {
  const blank = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  const n = blank ? NaN : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_ADMIN_WIN_INTERVAL) {
    throw new Error(`Enter a whole number from 0 to ${MAX_ADMIN_WIN_INTERVAL} (0 = off).`);
  }
  await HouseSettings.findByIdAndUpdate(
    'house',
    { $set: { predictedWinnerEveryGames: n, updatedBy: String(adminTelegramId || ''), updatedAt: new Date() } },
    { upsert: true, new: true }
  );
  logger.info('House ADMIN-WIN-INTERVAL changed', { everyGames: n, by: String(adminTelegramId || '') });
  return getAutoAllocationSettings();
}

/* -------------------------------------------------------------------------
 * Empty-round streak (per stake tier)
 * -------------------------------------------------------------------------
 * The engine reports the outcome of every selection round once it closes:
 * a round with at least 1 real cartela purchase resets the streak to 0; a
 * round with none adds 1. The house pauses at EMPTY_ROUNDS_TO_PAUSE (3) empty
 * rounds in a row and resumes after the next round with a real purchase.
 * Switching auto-allocation ON resets it. Never throws.
 * ----------------------------------------------------------------------- */
async function recordWindowOutcome(stake, hadRealPurchase) {
  try {
    await Counter.updateOne(
      { _id: `emptyStreak:${stake}` },
      hadRealPurchase ? { $set: { seq: 0 } } : { $inc: { seq: 1 } },
      { upsert: true }
    );
  } catch (err) {
    logger.error('Failed to record selection-round outcome', { stake, error: err.message });
  }
}

async function getEmptyStreak(stake) {
  const doc = await Counter.findById(`emptyStreak:${stake}`).lean();
  return doc ? doc.seq : 0;
}

/* -------------------------------------------------------------------------
 * Cartela selection algorithm
 * -------------------------------------------------------------------------
 * Replace the body of this function to change HOW the house picks cartelas.
 * It receives every currently-available cartelaId and must return up to
 * `count` of them, in the order they should be attempted.
 *
 * Current algorithm: unbiased random sample using a partial Fisher-Yates
 * shuffle driven by crypto.randomInt (not Math.random), so picks are
 * uniformly spread over the whole pool and cannot be predicted or gamed by
 * players. Because only `count` swaps are performed it is O(count), not
 * O(pool). Nothing here depends on cartela ID order (no "sweep from #1").
 * ----------------------------------------------------------------------- */
function pickCartelasForHouse(availableIds, count) {
  const pool = availableIds.slice();
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = crypto.randomInt(i, pool.length); // uniform in [i, pool.length)
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

async function ensureCounter(id) {
  try {
    await Counter.updateOne({ _id: id }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err; // concurrent creation by another caller — already exists
  }
}

/** The cartela the simulator ranks #1 for this game's draw sequence, or null if unavailable. */
async function predictedRankOneCartela(game) {
  if (!game.drawSequenceId) return null;
  const seq = await DrawSequence.findById(game.drawSequenceId).select('predictedWinners').lean();
  const first = seq && (seq.predictedWinners || []).find((w) => w.rank === 1);
  return first ? first.cartelaId : null;
}

/* -------------------------------------------------------------------------
 * Natural-looking house purchases
 * -------------------------------------------------------------------------
 * The house does not grab everything in one instant. Like a player it makes
 * several small purchases (1-2 cartelas each) at uneven intervals, all inside
 * the first 10-20 seconds of the selection round (the end of that spread is
 * picked at random per game), and each batch is frozen on every player's
 * screen the moment it is bought.
 *
 * Rules for a house purchase run (one per selection round):
 *   - an admin has switched auto-allocation ON, AMOUNT_ADMIN_CARTELAS > 0,
 *   - normally it starts in the first few seconds of the round, without
 *     waiting for a real player. If this stake is paused (3 rounds in a row
 *     ended with 0 real purchases — see recordWindowOutcome) it instead waits
 *     for a real player to buy in THIS round and then allocates in that same
 *     round, finishing before the round closes (a last-moment catch-up buys
 *     whatever is still outstanding so it is done before ACTIVE),
 *   - at most once per game (houseTopUpAt guard, set atomically),
 *   - nothing is bought in the last 2.5 s of the round.
 * Each batch is its own database transaction: claim cartelas with the atomic
 * {ownerId: null} guard, debit the House Wallet, log ADMIN_AUTO_PURCHASE and
 * add the stake to grossPrizePool (same as a real purchase).
 * ----------------------------------------------------------------------- */
const TIMING = {
  FIRST_MOVE_MIN: 1500, // first batch 1.5-4 s into the round (the initial few seconds)
  FIRST_MOVE_MAX: 4000,
  PAUSED_REACT_MIN: 800, // while paused: first batch 0.8-2 s after the first real purchase is seen
  PAUSED_REACT_MAX: 2000,
  PAUSED_SPREAD_MIN: 5000, // while paused: plan aims to finish 5-10 s after that purchase
  PAUSED_SPREAD_MAX: 10000,
  SPREAD_END_MIN: 10000, // plan aims to be finished 10-20 s into the round
  SPREAD_END_MAX: 20000,
  LATE_MARGIN: 2500, // never buy in the last 2.5 s
  POLL: 1000,
  MIN_GAP: 400,
  MAX_GAP: 4000
};

const randInt = (lo, hi) => crypto.randomInt(lo, hi + 1); // inclusive

function sleepUnlessCancelled(ms, ctl) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      clearInterval(watcher);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    const watcher = setInterval(() => { if (ctl.cancelled) done(); }, 50);
  });
}

/**
 * Atomic once-per-game step: sets the houseTopUpAt guard and, if the
 * ADMIN-WIN-INTERVAL is on, advances this stake's game counter. With
 * `requireReal` (paused mode) it does nothing unless a real player has bought.
 * Overlapping runs for the same game conflict on the Game document: one
 * aborts, retries, finds the guard already set and does nothing.
 */
async function createPlan(game, settings, { requireReal = false } = {}) {
  const gameId = game.gameId;
  const out = { ok: false, predictedDue: false, gamesSinceBuy: 0, budget: 0 };
  const counterId = `housePredictedBuy:${game.stake}`;
  if (settings.adminWinInterval > 0) await ensureCounter(counterId);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      out.ok = false;
      out.predictedDue = false;
      out.gamesSinceBuy = 0;
      out.budget = 0;

      if (requireReal) {
        const realNow = await GameCartela
          .countDocuments({ gameId, ownerId: { $nin: [null, 'system-admin'] } })
          .session(session);
        if (realNow < 1) return;
      }

      const guard = await Game.updateOne(
        { gameId, houseTopUpAt: null },
        { $set: { houseTopUpAt: new Date() } },
        { session }
      );
      if (guard.modifiedCount === 0) return;

      const house = await HouseWallet.findOne({ walletId: 'house' }).session(session);
      out.budget = Math.floor(((house && house.balance) || 0) / game.stake);

      if (settings.adminWinInterval > 0) {
        const counter = await Counter.findOneAndUpdate({ _id: counterId }, { $inc: { seq: 1 } }, { new: true, session });
        out.gamesSinceBuy = counter ? counter.seq : 0;
        out.predictedDue = !!counter && counter.seq >= settings.adminWinInterval;
      }
      out.ok = true;
    });
  } finally {
    session.endSession();
  }
  return out;
}

/**
 * One house purchase of up to `size` cartelas (a single database transaction).
 * If the plan says the predicted rank-1 buy is due, that cartela is attempted
 * first and counts as one of the `size`. Returns what was bought plus flags
 * telling the caller whether to stop (house out of money / pool exhausted).
 */
async function buyBatch(game, plan, size, houseUser) {
  const gameId = game.gameId;
  const counterId = `housePredictedBuy:${game.stake}`;
  const out = { predictedIds: [], randomIds: [], predictedTried: false, broke: false, exhausted: false, ids: [] };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      out.predictedIds = [];
      out.randomIds = [];
      out.predictedTried = false;
      out.broke = false;
      out.exhausted = false;

      const house = await HouseWallet.findOne({ walletId: 'house' }).session(session);
      const affordable = Math.floor(((house && house.balance) || 0) / game.stake);
      const k = Math.min(size, affordable);
      if (k < size) out.broke = true;
      if (k <= 0) return;

      if (plan.predictedPending) {
        out.predictedTried = true;
        if (plan.predictedTarget != null) {
          const claimed = await cartelaService.claimCartela(gameId, plan.predictedTarget, 'system-admin', session);
          if (claimed) out.predictedIds.push(plan.predictedTarget);
        }
      }

      const need = k - out.predictedIds.length;
      if (need > 0) {
        const rows = await GameCartela.find({ gameId, ownerId: null }, { cartelaId: 1 }).lean().session(session);
        const candidates = pickCartelasForHouse(rows.map((r) => r.cartelaId), rows.length);
        for (const cartelaId of candidates) {
          if (out.randomIds.length >= need) break;
          const claimed = await cartelaService.claimCartela(gameId, cartelaId, 'system-admin', session);
          if (claimed) out.randomIds.push(cartelaId);
        }
        if (out.randomIds.length < need) out.exhausted = true;
      }

      const count = out.predictedIds.length + out.randomIds.length;
      if (count === 0) return;

      const cost = count * game.stake;
      const debited = await HouseWallet.findOneAndUpdate(
        { walletId: 'house', balance: { $gte: cost } },
        { $inc: { balance: -cost } },
        { new: true, session }
      );
      if (!debited) throw new Error('House wallet balance changed — insufficient funds for auto-allocation');

      const rowsToWrite = [];
      if (out.predictedIds.length > 0) rowsToWrite.push({ ids: out.predictedIds, reason: 'predicted_winner', label: 'predicted rank-1 winner' });
      if (out.randomIds.length > 0) rowsToWrite.push({ ids: out.randomIds, reason: 'auto_allocation', label: 'auto-allocation' });
      for (const r of rowsToWrite) {
        await Transaction.create(
          [{
            userId: houseUser._id,
            type: 'ADMIN_AUTO_PURCHASE',
            amount: r.ids.length * game.stake,
            referenceId: await walletService.nextReferenceId(session),
            gameId,
            cartelaIds: [...r.ids],
            status: 'COMPLETED',
            description: `House auto-allocated ${r.ids.length} cartela(s) for game ${gameId} (${r.label})`,
            metadata: { reason: r.reason }
          }],
          { session }
        );
      }

      // Atomic $inc, same as purchaseCartelas — never read-modify-write.
      await Game.updateOne({ gameId }, { $inc: { grossPrizePool: cost } }, { session });

      // Restart the ADMIN-WIN-INTERVAL count only after a successful purchase of it.
      if (out.predictedIds.length > 0) {
        await Counter.updateOne({ _id: counterId }, { $set: { seq: 0 } }, { session });
      }
    });
  } finally {
    session.endSession();
  }
  out.ids = [...out.predictedIds, ...out.randomIds];
  return out;
}

/**
 * Runs the house's purchases for one selection round. Started by the engine
 * at the beginning of every selection round; resolves when the plan is done
 * or the round closes (the engine sets ctl.cancelled = true). Never throws —
 * an allocation problem must not take down the game loop.
 *
 * @param {object} game     the WAITING Game document
 * @param {object} opts
 *   ctl         { cancelled:boolean } — set by the engine when the round ends
 *   startedAt   ms timestamp the round (countdown) started
 *   selectionMs length of the selection round in ms
 *   onBatch(ids)       called right after each batch is bought
 *   onComplete(allIds) called once at the end if anything was bought
 *   timeScale   (tests only) divides every delay
 * @returns {Promise<{allocated:number, cartelaIds:number[]}>}
 */
async function runNaturalAllocation(game, opts) {
  const { ctl, startedAt, selectionMs, onBatch, onComplete } = opts;
  const scale = opts.timeScale || 1;
  const ms = (v) => Math.max(1, Math.round(v / scale));
  const gameId = game.gameId;

  const all = [];
  let predictedBought = false;
  const result = () => ({ allocated: all.length, cartelaIds: all });

  try {
    // Admin switch/amount/interval are read at the start of each round, so a
    // change in the Admin Panel applies from the next round.
    const settings = await getAutoAllocationSettings();
    if (!settings.enabled || settings.amount <= 0) return result();

    // Paused = 3+ consecutive rounds of this stake ended with 0 real purchases.
    const emptyStreak = await getEmptyStreak(game.stake);
    const paused = emptyStreak >= EMPTY_ROUNDS_TO_PAUSE;
    if (paused && emptyStreak === EMPTY_ROUNDS_TO_PAUSE) {
      // Logged once, when the pause begins — not on every idle round after it.
      logger.info('House auto-allocation paused — consecutive rounds with no real purchase', {
        gameId, stake: game.stake, emptyRounds: emptyStreak, pausesAt: EMPTY_ROUNDS_TO_PAUSE
      });
    }

    const houseUser = await User.findOne({ telegramId: HOUSE_TELEGRAM_ID });
    if (!houseUser) throw new Error('Sentinel house user not found');

    const hardStop = startedAt + selectionMs - ms(TIMING.LATE_MARGIN);
    let spreadEnd;

    if (!paused) {
      // 1) Normal mode: a natural first move a couple of seconds in — no waiting for a real player.
      spreadEnd = startedAt + ms(randInt(TIMING.SPREAD_END_MIN, TIMING.SPREAD_END_MAX));
      await sleepUnlessCancelled(startedAt + ms(randInt(TIMING.FIRST_MOVE_MIN, TIMING.FIRST_MOVE_MAX)) - Date.now(), ctl);
      if (ctl.cancelled) return result();
    } else {
      // 1) Paused mode: nothing is bought until a real player buys in this round.
      //    (The real count is checked before the cancel flag, so a purchase made
      //    just before the round closed is still seen.)
      for (;;) {
        const { real } = await cartelaService.countSold(gameId);
        if (real >= 1) break;
        if (ctl.cancelled) return result();
        await sleepUnlessCancelled(ms(TIMING.POLL), ctl);
      }
      spreadEnd = Math.min(hardStop, Date.now() + ms(randInt(TIMING.PAUSED_SPREAD_MIN, TIMING.PAUSED_SPREAD_MAX)));
      await sleepUnlessCancelled(ms(randInt(TIMING.PAUSED_REACT_MIN, TIMING.PAUSED_REACT_MAX)), ctl);
    }

    const fresh = await Game.findOne({ gameId });
    if (!fresh || fresh.status !== 'WAITING' || fresh.houseTopUpAt) return result();

    // 2) Once-per-game guard + decide whether the predicted buy is due.
    const created = await createPlan(fresh, settings, { requireReal: paused });
    if (!created.ok) return result();

    const total = Math.min(settings.amount, created.budget);
    if (total < settings.amount) {
      logger.warn('House auto-allocation is short of the set amount (House Wallet)', {
        gameId, stake: fresh.stake, wanted: settings.amount, affordable: created.budget
      });
    }
    if (total <= 0) return result();

    const plan = {
      remaining: total,
      predictedPending: created.predictedDue,
      predictedTarget: created.predictedDue ? await predictedRankOneCartela(fresh) : null
    };

    // Bookkeeping + live announcement for one bought batch. Returns true if the run should stop.
    const record = async (got) => {
      if (got.predictedTried) plan.predictedPending = false;
      if (got.ids.length > 0) {
        plan.remaining -= got.ids.length;
        all.push(...got.ids);
        if (got.predictedIds.length > 0) predictedBought = true;
        if (typeof onBatch === 'function') {
          try { await onBatch([...got.ids]); } catch (err) { logger.error('House batch announcement failed', { gameId, error: err.message }); }
        }
      }
      if (got.broke || got.exhausted || got.ids.length === 0) {
        if (got.broke || got.exhausted) {
          logger.warn('House auto-allocation ended early', { gameId, stake: fresh.stake, broke: got.broke, exhausted: got.exhausted, remaining: plan.remaining });
        }
        return true;
      }
      return false;
    };

    // 3) Buy in small batches at uneven intervals until done or time is up.
    let stopped = false;
    let first = true;
    while (plan.remaining > 0 && !ctl.cancelled) {
      let now = Date.now();
      if (now >= hardStop) {
        logger.info('House auto-allocation stopped at the end of the round', { gameId, stake: fresh.stake, remaining: plan.remaining });
        break;
      }
      const deadline = Math.min(Math.max(spreadEnd, now + ms(2000)), hardStop);

      if (!first) {
        const batchesLeft = Math.max(1, Math.ceil(plan.remaining / 1.5));
        const mean = (deadline - now) / batchesLeft;
        const gap = Math.min(ms(TIMING.MAX_GAP), Math.max(ms(TIMING.MIN_GAP), Math.round(mean * (0.5 + Math.random()))));
        await sleepUnlessCancelled(gap, ctl);
        if (ctl.cancelled) break;
        now = Date.now();
        if (now >= hardStop) continue; // handled at the top of the loop
      }
      first = false;

      // 1-2 cartelas per purchase, like a player — but never so small that the plan can't finish by the deadline.
      const slots = Math.max(1, Math.floor((deadline - now) / (2 * ms(TIMING.MIN_GAP))));
      const size = Math.min(plan.remaining, Math.max(randInt(1, 2), Math.ceil(plan.remaining / slots)));

      const got = await buyBatch(fresh, plan, size, houseUser);
      if (await record(got)) { stopped = true; break; }
    }

    // 4) Paused mode only: a real player is in this game, so the house MUST be in
    //    before the round goes ACTIVE. If the round closed (or the time ran out)
    //    with cartelas still outstanding, buy the rest right now.
    if (paused && !stopped && plan.remaining > 0) {
      logger.info('House auto-allocation catching up before the round starts', { gameId, stake: fresh.stake, remaining: plan.remaining });
      await record(await buyBatch(fresh, plan, plan.remaining, houseUser));
    }

    if (predictedBought) {
      logger.info('House bought predicted rank-1 winner cartela', { gameId, stake: fresh.stake, everyGames: settings.adminWinInterval });
    } else if (created.predictedDue) {
      logger.info('Predicted rank-1 cartela not bought (taken, missing, or unaffordable) — will retry next game', {
        gameId, stake: fresh.stake, target: plan.predictedTarget, gamesSinceBuy: created.gamesSinceBuy
      });
    }
    if (all.length > 0) {
      logger.info('House auto-allocated cartelas', {
        gameId, stake: fresh.stake, count: all.length, amount: settings.amount, emptyRounds: emptyStreak, pausedMode: paused
      });
      if (typeof onComplete === 'function') {
        try { await onComplete([...all]); } catch (err) { logger.error('House completion announcement failed', { gameId, error: err.message }); }
      }
    }
    return result();
  } catch (err) {
    logger.error('House auto-allocation failed', { gameId, error: err.message, stack: err.stack });
    return result();
  }
}

/* -------------------------------------------------------------------------
 * House display names (shown when an auto-allocated cartela wins)
 * ----------------------------------------------------------------------- */
let cachedHouseNames = null;

/** Finds data/house_names (any case/spaces/underscores, optional .csv/.txt). */
function loadHouseNames() {
  if (cachedHouseNames) return cachedHouseNames;

  const dirs = [
    path.resolve(__dirname, '../../../data'), // repo-root /data
    path.resolve(__dirname, '../../data'), // backend/data (if copied alongside the service)
    path.join(process.cwd(), 'data'),
    path.join(process.cwd(), '..', 'data')
  ];

  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    const match = files.find((f) => /^housenames(\.csv|\.txt)?$/.test(f.toLowerCase().replace(/[\s_-]+/g, '')));
    if (!match) continue;

    const names = fs
      .readFileSync(path.join(dir, match), 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.split(',')[0].trim().replace(/^"|"$/g, '').trim())
      .filter(Boolean);

    if (names.length > 0) {
      cachedHouseNames = names;
      logger.info('Loaded house names', { file: path.join(dir, match), count: names.length });
      return cachedHouseNames;
    }
  }

  logger.warn('House names file not found or empty (expected data/house_names) — house wins will show no name');
  cachedHouseNames = [];
  return cachedHouseNames;
}

/** Most recently handed-out house names (newest last), so back-to-back wins don't repeat a name. */
const recentHouseNames = [];

/**
 * Picks a house display name at random (crypto.randomInt — unpredictable, no
 * fixed order or cycle) from the data/house_names list. To keep it from
 * looking repetitive it avoids (a) names in `exclude` — pass the names already
 * given to other house winners of the same game — and (b) the last few names
 * handed out by this process. If those rules leave nothing to choose from it
 * falls back to the whole list. Returns null if no names are available.
 */
function nextHouseName({ exclude = [] } = {}) {
  const names = loadHouseNames();
  if (names.length === 0) return null;

  const blocked = new Set([...exclude, ...recentHouseNames]);
  let pool = names.filter((n) => !blocked.has(n));
  if (pool.length === 0) pool = names.filter((n) => !exclude.includes(n));
  if (pool.length === 0) pool = names;

  const pick = pool[crypto.randomInt(0, pool.length)];

  // Remember up to 1/3 of the list (at most 5) so the memory never starves the pool.
  const keep = Math.max(1, Math.min(5, Math.floor(names.length / 3)));
  recentHouseNames.push(pick);
  while (recentHouseNames.length > keep) recentHouseNames.shift();
  return pick;
}

module.exports = {
  EMPTY_ROUNDS_TO_PAUSE,
  MAX_AMOUNT_ADMIN_CARTELAS,
  MAX_ADMIN_WIN_INTERVAL,
  getAutoAllocationSettings,
  setAutoAllocationEnabled,
  setAmountAdminCartelas,
  setAdminWinInterval,
  recordWindowOutcome,
  getEmptyStreak,
  pickCartelasForHouse,
  runNaturalAllocation,
  nextHouseName
};
