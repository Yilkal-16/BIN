const express = require('express');
const { AdminRequest, User, HouseWallet, Game } = require('../models');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { ok, fail, asyncHandler, paginationParams } = require('../utils/helpers');
const walletService = require('../services/walletService');
const notificationService = require('../services/notificationService');
const engine = require('../game/engine');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/dashboard', asyncHandler(async (req, res) => {
  const [house, pendingDeposits, reversibleDeposits, pendingWithdrawals, totalUsers, activeGames] = await Promise.all([
    HouseWallet.findOne({ walletId: 'house' }),
    // Deposits never sit at PENDING (see walletService.submitDeposit) — a
    // deposit needing admin action is either MANUAL_REVIEW (needs APPROVE)
    // or APPROVED (open/reversible until an admin explicitly REVERSEs or
    // FINALIZEs it — no automatic time limit).
    AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'MANUAL_REVIEW' }),
    AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'APPROVED' }),
    AdminRequest.countDocuments({ type: 'WITHDRAW', status: 'PENDING' }),
    User.countDocuments({ isAdmin: false }),
    // Each stake tier (§4.5) runs its own concurrent game, so more than one
    // can be in-flight at once — return every active tier, not just one.
    Game.find({ status: { $in: ['WAITING', 'ACTIVE', 'SETTLING'] } }).sort({ stake: 1 })
  ]);
  return ok(res, {
    houseWalletBalance: house ? house.balance : 0,
    pendingDeposits,
    reversibleDeposits,
    pendingWithdrawals,
    totalUsers,
    enginePaused: engine.isPaused(),
    activeGames: activeGames.map((g) => ({
      gameId: g.gameId,
      stake: g.stake,
      status: g.status,
      currentDrawIndex: g.currentDrawIndex
    }))
  });
}));

router.get('/requests', asyncHandler(async (req, res) => {
  const { type, status } = req.query;
  const { limit, offset } = paginationParams(req.query);

  const filter = {};

  if (type) filter.type = type;

  if (status) {
    filter.status = status;
  } else if (type === 'DEPOSIT') {
    // Deposits never sit at PENDING (see walletService.submitDeposit) —
    // MANUAL_REVIEW needs an APPROVE action, APPROVED is open/reversible
    // until an admin explicitly REVERSEs or FINALIZEs it.
    filter.status = { $in: ['MANUAL_REVIEW', 'APPROVED'] };
  } else if (type === 'WITHDRAW') {
    filter.status = 'PENDING';
  } else {
    // No type filter given — combine both action-needed sets rather than
    // a single default status, since DEPOSIT and WITHDRAW mean different
    // things by "needs action" now.
    filter.$or = [
      { type: 'WITHDRAW', status: 'PENDING' },
      { type: 'DEPOSIT', status: { $in: ['MANUAL_REVIEW', 'APPROVED'] } }
    ];
  }

  // APPROVED deposits have no automatic expiry — they can sit open
  // indefinitely until an admin acts — so an unbounded backlog of older
  // approvals would otherwise bury freshly-approved ones under a fixed
  // page size forever. Newest-first surfaces what's actually new; oldest
  // first (FIFO) everywhere else, since those are items actively waiting
  // on a decision and should be handled in order received.
  const sortOrder = status === 'APPROVED' ? -1 : 1;

  const [requests, total] = await Promise.all([
    AdminRequest.find(filter).populate('userId', 'displayName phone telegramId').sort({ createdAt: sortOrder }).skip(offset).limit(limit),
    AdminRequest.countDocuments(filter)
  ]);
  return ok(res, { requests, pagination: { limit, offset, total, hasMore: offset + requests.length < total } });
}));

router.post('/deposit/approve', asyncHandler(async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) return fail(res, 400, 'INVALID_AMOUNT', 'requestId is required');
  const { transaction, adminRequest, newBalance } = await walletService.approveDeposit(requestId, req.userId);
  const user = await User.findById(adminRequest.userId);
  await notificationService.notifyTelegram(
    user.telegramId,
    `✅ *Deposit Successful!*\nYour wallet has been credited with ${transaction.amount} Birr.\n💰 *New Balance:* ${newBalance} Birr`
  );
  return ok(res, { adminRequest, newBalance });
}));

// Admin's REVERSE (+40%) action on a deposit that's currently APPROVED
// (auto-verified or previously manually approved), used after a manual
// double-check turns up a fraudulent/incorrect deposit.
router.post('/deposit/reverse', asyncHandler(async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) return fail(res, 400, 'INVALID_AMOUNT', 'requestId is required');
  const { transaction, adminRequest, newBalance, penaltyAmount, totalDeduction } = await walletService.reverseDeposit(requestId, req.userId);
  const user = await User.findById(adminRequest.userId);
  await notificationService.notifyTelegram(
    user.telegramId,
    `❌ *Deposit Reversed*\nA 40% penalty (${penaltyAmount} Birr) has been applied.\n💰 *New Balance:* ${newBalance} Birr`
  );
  return ok(res, { adminRequest, newBalance, penaltyAmount, totalDeduction });
}));

// Admin's explicit "Finalize" action on a deposit that's currently
// APPROVED: confirms it's genuine and closes its reversal window. No
// automatic time limit — a deposit stays open/reversible until an admin
// explicitly finalizes or reverses it.
router.post('/deposit/finalize', asyncHandler(async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) return fail(res, 400, 'INVALID_AMOUNT', 'requestId is required');
  const { adminRequest } = await walletService.finalizeDeposit(requestId, req.userId);
  return ok(res, { adminRequest });
}));

router.post('/deposit/decline', asyncHandler(async (req, res) => {
  const { requestId, reason } = req.body || {};
  if (!requestId || !reason) return fail(res, 400, 'INVALID_AMOUNT', 'requestId and reason are required');
  const { adminRequest } = await walletService.declineDeposit(requestId, req.userId, reason);
  const user = await User.findById(adminRequest.userId);
  await notificationService.notifyTelegram(user.telegramId, `❌ *Deposit Declined*\nReason: ${reason}`);
  return ok(res, { adminRequest });
}));

router.post('/withdraw/approve', asyncHandler(async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) return fail(res, 400, 'INVALID_AMOUNT', 'requestId is required');
  const { adminRequest } = await walletService.approveWithdrawal(requestId, req.userId);
  const user = await User.findById(adminRequest.userId);
  await notificationService.notifyTelegram(
    user.telegramId,
    `✅ *Withdrawal Approved!*\nYour withdrawal of ${adminRequest.amount} Birr has been processed.`
  );
  return ok(res, { adminRequest });
}));

router.post('/withdraw/decline', asyncHandler(async (req, res) => {
  const { requestId, reason } = req.body || {};
  if (!requestId || !reason) return fail(res, 400, 'INVALID_AMOUNT', 'requestId and reason are required');
  const { adminRequest, newBalance } = await walletService.declineWithdrawal(requestId, req.userId, reason);
  const user = await User.findById(adminRequest.userId);
  await notificationService.notifyTelegram(
    user.telegramId,
    `❌ *Withdrawal Declined*\nReason: ${reason}\n💰 *Available Balance:* ${newBalance} Birr`
  );
  return ok(res, { adminRequest, newBalance });
}));

router.post('/credit', asyncHandler(async (req, res) => {
  const { userId, amount, description } = req.body || {};
  if (!userId || !amount) return fail(res, 400, 'INVALID_AMOUNT', 'userId and amount are required');
  const { newBalance } = await walletService.adminCredit(userId, Number(amount), req.userId, description);
  const user = await User.findById(userId);
  await notificationService.notifyTelegram(
    user.telegramId,
    `💰 Your wallet has been credited with ${amount} Birr by an admin.\nNew balance: ${newBalance} Birr`
  );
  return ok(res, { newBalance });
}));

// Pauses/resumes the continuous engine (§0.4/§8.6) — the in-progress round
// always finishes; this only prevents the *next* round from starting.
router.post('/game/stop', asyncHandler(async (req, res) => {
  engine.pause();
  return ok(res, { paused: true });
}));

router.post('/game/start', asyncHandler(async (req, res) => {
  engine.resume();
  return ok(res, { paused: false });
}));

router.post('/announce', asyncHandler(async (req, res) => {
  const { message } = req.body || {};
  if (!message) return fail(res, 400, 'INVALID_AMOUNT', 'message is required');
  const users = await User.find({ isAdmin: false }, { telegramId: 1 }).lean();
  let sent = 0;
  for (const u of users) {
    await notificationService.notifyTelegram(u.telegramId, `📢 *Announcement*\n${message}`);
    sent += 1;
    await new Promise((resolve) => setTimeout(resolve, 40)); // stay well under Telegram's rate limits
  }
  return ok(res, { sent });
}));

module.exports = router;
