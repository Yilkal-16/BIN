const mongoose = require('mongoose');
const { User, Transaction, AdminRequest, HouseWallet, getNextSequence } = require('../models');
const { generateReferenceId } = require('../utils/helpers');
const { ApiError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

/**
 * ============================================================================
 * House Wallet accounting model
 * ============================================================================
 * §7.2's per-type "Effect on House Wallet" column mixes two different
 * things under one balance unless read carefully: GAME_PURCHASE's
 * "+Amount (to pool)" is money entering *this round's escrow*, not the
 * house's own retained earnings — while HOUSE_COMMISSION / HOUSE_FRACTIONAL /
 * HOUSE_WINNING / ADMIN_AUTO_PURCHASE / ADMIN_CREDIT describe genuine
 * house-owned-money movements. Treating every row as an equally-real,
 * independently-additive mutation to the *same* balance double-counts
 * (verified by simulating full rounds both ways): commission would be taken
 * "on top of" money that GAME_PURCHASE already credited, rather than being a
 * slice of it.
 *
 * The resolution that matches real cash flow exactly in every simulated
 * case (organic rounds, auto-allocated rounds, and admin-cartela-wins
 * rounds alike) is to let the round's escrow live on the Game document
 * itself (grossPrizePool / prizePool — already part of §9.3's schema) and
 * reserve House Wallet's `balance` for house-owned-money events only:
 *
 *   GAME_PURCHASE (real player)         user -amount   house: no change (enters this game's escrow)
 *   WINNING       (real player wins)    user +amount   house: no change (paid out of that escrow)
 *   ADMIN_AUTO_PURCHASE                 —              house -= amount  (real spend, inflates the escrow)
 *   HOUSE_COMMISSION                    —              house += amount  (real earning, taken from the escrow)
 *   HOUSE_FRACTIONAL                    —              house += amount  (real earning, rounding leftover)
 *   HOUSE_WINNING (admin cartela wins)  —              house += amount  (that escrow share becomes house money)
 *   ADMIN_CREDIT                        user +amount   house -= amount  (house gives away its own money)
 *   DEPOSIT / WITHDRAW                  user ± amount  house: no change
 *   ROLLOVER (no winner)                —              house: no change (escrow carries into the next game's pool)
 *
 * Every type above is still recorded as its own Transaction row exactly as
 * named in §9.5 — this only changes which rows mutate HouseWallet.balance,
 * so the full audit trail (§10.5 "audit trail for all admin actions" /
 * §7.2 "authoritative source for all balance changes") is unaffected.
 * ============================================================================
 */
const HOUSE_MUTATING_TYPES = new Set(['ADMIN_AUTO_PURCHASE', 'HOUSE_COMMISSION', 'HOUSE_FRACTIONAL', 'HOUSE_WINNING', 'ADMIN_CREDIT']);

async function nextReferenceId() {
  const seq = await getNextSequence(`referenceId:${new Date().toISOString().slice(0, 10)}`);
  return generateReferenceId(seq);
}

async function getHouseWallet(session) {
  return HouseWallet.findOne({ walletId: 'house' }).session(session || null);
}

/** Cached-balance read (fast path). */
async function getBalance(userId) {
  const user = await User.findById(userId).select('mainWalletBalance coins');
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
  return { mainWallet: user.mainWalletBalance, coins: user.coins };
}

/** Recomputes a user's balance directly from the ledger (audit/reconciliation use). */
async function recomputeBalanceFromLedger(userId) {
  const transactions = await Transaction.find({ userId, status: 'COMPLETED' });
  return transactions.reduce((sum, tx) => {
    if (['DEPOSIT', 'WINNING', 'ADMIN_CREDIT'].includes(tx.type)) return sum + tx.amount;
    if (['WITHDRAW', 'GAME_PURCHASE'].includes(tx.type)) return sum - tx.amount;
    return sum;
  }, 0);
}

/**
 * Submits a deposit request and attempts automatic verification.
 * Idempotent on receiptNumber (§4.3 Admin Override note / §8.4).
 */
async function submitDeposit(userId, amount, rawProof) {
  if (!(amount >= Number(process.env.DEPOSIT_MIN_AMOUNT || 10)) ||
      amount > Number(process.env.DEPOSIT_MAX_AMOUNT || 50000)) {
    throw new ApiError(400, 'INVALID_AMOUNT', 'Deposit amount is outside the allowed range.');
  }

  // Parse first so the dedup key is the actual transaction ID (stable,
  // canonical) rather than the raw pasted blob (fragile — two pastes of the
  // same SMS with a stray extra space would otherwise be treated as
  // different receipts). If nothing recognizable can be extracted, dedup
  // falls back to skipping the receiptNumber entirely (sparse unique index
  // permits that) and the request goes straight to manual review.
  const { parseProofInput, verifyDepositDetailed } = require('./telebirrVerification');
  const parsed = parseProofInput(rawProof);
  const dedupKey = parsed.transactionId || null;

  if (dedupKey) {
    const existing = await Transaction.findOne({ receiptNumber: dedupKey });
    if (existing) {
      return { duplicate: true, transaction: existing };
    }
  }

  const referenceId = await nextReferenceId();
  let transaction;
  try {
    transaction = await Transaction.create({
      userId,
      type: 'DEPOSIT',
      amount,
      receiptNumber: dedupKey || undefined,
      referenceId,
      status: 'PENDING',
      description: 'Deposit pending verification',
      metadata: { rawProof, parsedTransactionId: dedupKey }
    });
  } catch (err) {
    if (err.code === 11000) {
      const dup = await Transaction.findOne({ receiptNumber: dedupKey });
      return { duplicate: true, transaction: dup };
    }
    throw err;
  }

  const adminRequest = await AdminRequest.create({
    userId,
    type: 'DEPOSIT',
    amount,
    proof: rawProof, // full pasted text, kept verbatim for admin review
    status: 'PENDING'
  });

  // Link the two records explicitly — receiptNumber is now the parsed
  // transaction ID (or absent), not the raw proof text, so it can no
  // longer double as the join key between AdminRequest.proof and this
  // Transaction the way it used to.
  transaction.metadata = { ...transaction.metadata, adminRequestId: adminRequest._id.toString() };
  await transaction.save();

  // Attempt automated verification against the official Telebirr receipt.
  let verifyResult = { verified: false, reason: 'ERROR' };
  try {
    verifyResult = await verifyDepositDetailed({ amount, rawProof });
  } catch (err) {
    logger.warn('Deposit verification threw unexpectedly, falling back to manual admin review', {
      error: err.message
    });
  }

  if (verifyResult.verified) {
    const result = await approveDepositInternal({ transaction, adminRequest, adminId: null, auto: true });
    return { duplicate: false, verified: true, ...result };
  }

  logger.info('Deposit not auto-verified, awaiting manual review', {
    userId: String(userId),
    reason: verifyResult.reason
  });
  return { duplicate: false, verified: false, reason: verifyResult.reason, transaction, adminRequest };
}

async function approveDepositInternal({ transaction, adminRequest, adminId, auto = false }) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      transaction.status = 'COMPLETED';
      await transaction.save({ session });

      await User.updateOne(
        { _id: transaction.userId },
        { $inc: { mainWalletBalance: transaction.amount }, $set: { lastActive: new Date() } }
      ).session(session);

      adminRequest.status = 'APPROVED';
      adminRequest.completedAt = new Date();
      if (adminId) adminRequest.adminId = adminId;
      if (auto) adminRequest.adminNotes = 'Auto-approved by verification engine';
      await adminRequest.save({ session });
    });
  } finally {
    session.endSession();
  }
  const user = await User.findById(transaction.userId);
  return { transaction, adminRequest, newBalance: user.mainWalletBalance };
}

/** Manual admin approval path for a deposit the auto-verifier couldn't confirm. */
async function approveDeposit(adminRequestId, adminId) {
  const adminRequest = await AdminRequest.findById(adminRequestId);
  if (!adminRequest || adminRequest.type !== 'DEPOSIT') {
    throw new ApiError(404, 'NOT_FOUND', 'Deposit request not found');
  }
  if (adminRequest.status !== 'PENDING') {
    throw new ApiError(409, 'DUPLICATE_WITHDRAWAL_APPROVAL', `Request already ${adminRequest.status}`);
  }
  const transaction = await Transaction.findOne({ 'metadata.adminRequestId': adminRequest._id.toString() });
  if (!transaction) throw new ApiError(404, 'NOT_FOUND', 'Linked transaction not found');

  return approveDepositInternal({ transaction, adminRequest, adminId, auto: false });
}

async function declineDeposit(adminRequestId, adminId, reason) {
  const adminRequest = await AdminRequest.findById(adminRequestId);
  if (!adminRequest || adminRequest.type !== 'DEPOSIT') {
    throw new ApiError(404, 'NOT_FOUND', 'Deposit request not found');
  }
  if (adminRequest.status !== 'PENDING') {
    throw new ApiError(409, 'DUPLICATE_WITHDRAWAL_APPROVAL', `Request already ${adminRequest.status}`);
  }
  const transaction = await Transaction.findOne({ 'metadata.adminRequestId': adminRequest._id.toString() });

  adminRequest.status = 'DECLINED';
  adminRequest.declineReason = reason;
  adminRequest.adminId = adminId;
  adminRequest.completedAt = new Date();
  await adminRequest.save();

  if (transaction) {
    transaction.status = 'FAILED';
    await transaction.save();
  }
  return { adminRequest, transaction };
}

/** Admin manually credits a user's wallet, funded from the House Wallet (§7.2). */
async function adminCredit(targetUserId, amount, adminId, description = 'Manual admin credit') {
  if (!(amount > 0)) throw new ApiError(400, 'INVALID_AMOUNT', 'Credit amount must be positive');
  const referenceId = await nextReferenceId();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Transaction.create(
        [{ userId: targetUserId, type: 'ADMIN_CREDIT', amount, referenceId, status: 'COMPLETED', description, metadata: { adminId } }],
        { session }
      );
      await User.updateOne({ _id: targetUserId }, { $inc: { mainWalletBalance: amount } }).session(session);
      await HouseWallet.updateOne({ walletId: 'house' }, { $inc: { balance: -amount } }).session(session);
    });
  } finally {
    session.endSession();
  }
  const user = await User.findById(targetUserId);
  return { newBalance: user.mainWalletBalance };
}

/**
 * Withdrawal request: places an immediate hold by deducting from the user's
 * available balance up front (§4.4 Step 3 — "Critical: the withdrawal
 * amount is placed on hold").
 */
async function requestWithdrawal(userId, amount) {
  const min = Number(process.env.WITHDRAW_MIN_AMOUNT || 50);
  const max = Number(process.env.WITHDRAW_MAX_AMOUNT || 15000);
  if (amount < min || amount > max) {
    throw new ApiError(400, 'INVALID_AMOUNT', `Withdrawal amount must be between ${min} and ${max} Birr.`);
  }

  const referenceId = await nextReferenceId();
  const session = await mongoose.startSession();
  let transaction, adminRequest;
  try {
    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');
      if (user.mainWalletBalance < amount) {
        throw new ApiError(400, 'INSUFFICIENT_BALANCE', 'Insufficient balance for this withdrawal.', {
          required: amount,
          available: user.mainWalletBalance
        });
      }

      user.mainWalletBalance -= amount;
      await user.save({ session });

      const created = await Transaction.create(
        [{ userId, type: 'WITHDRAW', amount, referenceId, status: 'PENDING', description: 'Withdrawal pending admin approval' }],
        { session }
      );
      transaction = created[0];

      const createdRequest = await AdminRequest.create(
        [{ userId, type: 'WITHDRAW', amount, heldAmount: amount, status: 'PENDING' }],
        { session }
      );
      adminRequest = createdRequest[0];

      transaction.metadata = { adminRequestId: adminRequest._id.toString() };
      await transaction.save({ session });
    });
  } finally {
    session.endSession();
  }

  const user = await User.findById(userId);
  return { transaction, adminRequest, availableBalance: user.mainWalletBalance };
}

async function approveWithdrawal(adminRequestId, adminId) {
  const adminRequest = await AdminRequest.findById(adminRequestId);
  if (!adminRequest || adminRequest.type !== 'WITHDRAW') {
    throw new ApiError(404, 'NOT_FOUND', 'Withdrawal request not found');
  }
  if (adminRequest.status !== 'PENDING') {
    throw new ApiError(409, 'DUPLICATE_WITHDRAWAL_APPROVAL', `Withdrawal already ${adminRequest.status}`);
  }

  adminRequest.status = 'APPROVED';
  adminRequest.adminId = adminId;
  adminRequest.completedAt = new Date();
  adminRequest.payoutConfirmed = true;
  await adminRequest.save();

  const transaction = await Transaction.findOne({ 'metadata.adminRequestId': adminRequest._id.toString() });
  if (transaction) {
    transaction.status = 'COMPLETED';
    await transaction.save();
  }
  return { adminRequest, transaction };
}

async function declineWithdrawal(adminRequestId, adminId, reason) {
  const adminRequest = await AdminRequest.findById(adminRequestId);
  if (!adminRequest || adminRequest.type !== 'WITHDRAW') {
    throw new ApiError(404, 'NOT_FOUND', 'Withdrawal request not found');
  }
  if (adminRequest.status !== 'PENDING') {
    throw new ApiError(409, 'DUPLICATE_WITHDRAWAL_APPROVAL', `Withdrawal already ${adminRequest.status}`);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      adminRequest.status = 'DECLINED';
      adminRequest.declineReason = reason;
      adminRequest.adminId = adminId;
      adminRequest.releaseDate = new Date();
      adminRequest.completedAt = new Date();
      await adminRequest.save({ session });

      const transaction = await Transaction.findOne({ 'metadata.adminRequestId': adminRequest._id.toString() }).session(session);
      if (transaction) {
        transaction.status = 'FAILED';
        await transaction.save({ session });
      }

      await User.updateOne({ _id: adminRequest.userId }, { $inc: { mainWalletBalance: adminRequest.heldAmount } }).session(session);
    });
  } finally {
    session.endSession();
  }

  const user = await User.findById(adminRequest.userId);
  return { adminRequest, newBalance: user.mainWalletBalance };
}

/** Auto-releases withdrawals stuck PENDING past WITHDRAW_HOLD_TIMEOUT seconds (§4.4/§12). */
async function autoReleaseStaleWithdrawals() {
  const timeoutSeconds = Number(process.env.WITHDRAW_HOLD_TIMEOUT || 172800);
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
  const stale = await AdminRequest.find({ type: 'WITHDRAW', status: 'PENDING', createdAt: { $lte: cutoff } });

  const released = [];
  for (const adminRequest of stale) {
    try {
      const session = await mongoose.startSession();
      await session.withTransaction(async () => {
        adminRequest.status = 'DECLINED';
        adminRequest.declineReason = 'Auto-release due to timeout';
        adminRequest.releaseDate = new Date();
        adminRequest.completedAt = new Date();
        await adminRequest.save({ session });

        const original = await Transaction.findOne({ 'metadata.adminRequestId': adminRequest._id.toString() }).session(session);
        if (original) {
          original.status = 'FAILED';
          await original.save({ session });
        }

        const referenceId = await nextReferenceId();
        await Transaction.create(
          [{
            userId: adminRequest.userId,
            type: 'ADMIN_CREDIT',
            amount: adminRequest.heldAmount,
            referenceId,
            status: 'COMPLETED',
            description: 'Auto-release due to timeout'
          }],
          { session }
        );
        await User.updateOne({ _id: adminRequest.userId }, { $inc: { mainWalletBalance: adminRequest.heldAmount } }).session(session);
      });
      session.endSession();
      released.push(adminRequest);
    } catch (err) {
      logger.error('Failed to auto-release stale withdrawal', { adminRequestId: adminRequest._id, error: err.message });
    }
  }
  return released;
}

module.exports = {
  HOUSE_MUTATING_TYPES,
  nextReferenceId,
  getHouseWallet,
  getBalance,
  recomputeBalanceFromLedger,
  submitDeposit,
  approveDeposit,
  declineDeposit,
  adminCredit,
  requestWithdrawal,
  approveWithdrawal,
  declineWithdrawal,
  autoReleaseStaleWithdrawals
};
