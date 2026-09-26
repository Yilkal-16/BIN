const { User, Game, AdminRequest } = require('../models');
const { STAKES } = require('../utils/helpers');

/**
 * Transaction Summary (Admin Panel "📊 Transaction Summary" tab).
 *
 * Buckets are calendar-based, computed against the server's local clock
 * (same convention the rest of the codebase uses — no timezone handling
 * elsewhere, e.g. walletService's `new Date()` timestamps):
 *   - daily:   since local midnight today
 *   - weekly:  since local midnight on this week's Monday
 *   - monthly: since local midnight on the 1st of this month
 *   - total:   all-time, no lower bound
 */
function getPeriodStarts(now = new Date()) {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const dayOfWeek = startOfDay.getDay(); // 0 = Sun .. 6 = Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon = 0
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setDate(startOfWeek.getDate() - daysSinceMonday);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return { daily: startOfDay, weekly: startOfWeek, monthly: startOfMonth, total: null };
}

/** Pulls a $facet bucket's single-count result out, defaulting to 0. */
function countOf(facetResult) {
  return (facetResult && facetResult[0] && facetResult[0].count) || 0;
}

/** Pulls a $facet bucket's {count, total} sum result out, defaulting to zeros. */
function sumOf(facetResult) {
  const row = facetResult && facetResult[0];
  return { count: (row && row.count) || 0, total: (row && row.total) || 0 };
}

/** Pulls a $facet bucket's per-stake group-count results into a {stake: count} map. */
function stakeCountsOf(facetResult) {
  const map = {};
  STAKES.forEach((s) => { map[s] = 0; });
  (facetResult || []).forEach((row) => {
    if (row._id !== null && row._id !== undefined) map[row._id] = row.count;
  });
  return map;
}

/**
 * Registered users per period. Excludes admin accounts, matching the
 * existing dashboard counters (see admin.js /dashboard, commands.js
 * handleAdminDashboard).
 */
async function getUserCounts(periods) {
  const [result] = await User.aggregate([
    { $match: { isAdmin: false } },
    {
      $facet: {
        daily: [{ $match: { createdAt: { $gte: periods.daily } } }, { $count: 'count' }],
        weekly: [{ $match: { createdAt: { $gte: periods.weekly } } }, { $count: 'count' }],
        monthly: [{ $match: { createdAt: { $gte: periods.monthly } } }, { $count: 'count' }],
        total: [{ $count: 'count' }]
      }
    }
  ]);
  return {
    daily: countOf(result.daily),
    weekly: countOf(result.weekly),
    monthly: countOf(result.monthly),
    total: countOf(result.total)
  };
}

/**
 * Games played per period, broken down by stake tier. "Played" = reached
 * COMPLETED (§8.6), bucketed by endTime (when the round actually finished)
 * rather than createdAt/startTime.
 */
async function getGameStakeCounts(periods) {
  const groupByStake = { $group: { _id: '$stake', count: { $sum: 1 } } };
  const [result] = await Game.aggregate([
    { $match: { status: 'COMPLETED' } },
    {
      $facet: {
        daily: [{ $match: { endTime: { $gte: periods.daily } } }, groupByStake],
        weekly: [{ $match: { endTime: { $gte: periods.weekly } } }, groupByStake],
        monthly: [{ $match: { endTime: { $gte: periods.monthly } } }, groupByStake],
        total: [groupByStake]
      }
    }
  ]);
  return {
    daily: stakeCountsOf(result.daily),
    weekly: stakeCountsOf(result.weekly),
    monthly: stakeCountsOf(result.monthly),
    total: stakeCountsOf(result.total)
  };
}

/**
 * Deposits made per period — FINALIZED only (an admin has explicitly
 * confirmed the deposit genuine and closed its reversal window; see
 * walletService.finalizeDeposit). MANUAL_REVIEW/APPROVED/REVERSED deposits
 * are intentionally excluded. Bucketed by completedAt, the moment the
 * finalize action happened.
 */
async function getDepositTotals(periods) {
  const groupSum = { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } };
  const [result] = await AdminRequest.aggregate([
    { $match: { type: 'DEPOSIT', status: 'FINALIZED' } },
    {
      $facet: {
        daily: [{ $match: { completedAt: { $gte: periods.daily } } }, groupSum],
        weekly: [{ $match: { completedAt: { $gte: periods.weekly } } }, groupSum],
        monthly: [{ $match: { completedAt: { $gte: periods.monthly } } }, groupSum],
        total: [groupSum]
      }
    }
  ]);
  return {
    daily: sumOf(result.daily),
    weekly: sumOf(result.weekly),
    monthly: sumOf(result.monthly),
    total: sumOf(result.total)
  };
}

/**
 * Withdrawals made per period — APPROVED only (an admin has approved and
 * processed the payout; see walletService.approveWithdrawal). PENDING/
 * DECLINED withdrawals are intentionally excluded. Bucketed by completedAt,
 * the moment the approval happened.
 */
async function getWithdrawalTotals(periods) {
  const groupSum = { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' } } };
  const [result] = await AdminRequest.aggregate([
    { $match: { type: 'WITHDRAW', status: 'APPROVED' } },
    {
      $facet: {
        daily: [{ $match: { completedAt: { $gte: periods.daily } } }, groupSum],
        weekly: [{ $match: { completedAt: { $gte: periods.weekly } } }, groupSum],
        monthly: [{ $match: { completedAt: { $gte: periods.monthly } } }, groupSum],
        total: [groupSum]
      }
    }
  ]);
  return {
    daily: sumOf(result.daily),
    weekly: sumOf(result.weekly),
    monthly: sumOf(result.monthly),
    total: sumOf(result.total)
  };
}

/** Full transaction summary — see the "TRANSACTION" admin panel tab. */
async function getTransactionSummary(now = new Date()) {
  const periods = getPeriodStarts(now);
  const [users, gamesByStake, deposits, withdrawals] = await Promise.all([
    getUserCounts(periods),
    getGameStakeCounts(periods),
    getDepositTotals(periods),
    getWithdrawalTotals(periods)
  ]);
  return { generatedAt: now, users, gamesByStake, deposits, withdrawals };
}

module.exports = { getTransactionSummary, getPeriodStarts };
