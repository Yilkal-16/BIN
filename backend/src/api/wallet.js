const express = require('express');
const { Transaction } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { depositRateLimit, rateLimit } = require('../middleware/rateLimit');
const { ok, fail, paginationParams, asyncHandler } = require('../utils/helpers');
const walletService = require('../services/walletService');
const notificationService = require('../services/notificationService');

const router = express.Router();
router.use(requireAuth);

router.get('/balance', asyncHandler(async (req, res) => {
  const balance = await walletService.getBalance(req.userId);
  return ok(res, balance);
}));

router.post('/deposit', depositRateLimit, asyncHandler(async (req, res) => {
  const { amount, proof } = req.body || {};
  if (!amount || !proof) return fail(res, 400, 'INVALID_AMOUNT', 'amount and proof are required');

  const result = await walletService.submitDeposit(req.userId, Number(amount), String(proof));
  if (result.duplicate) {
    return fail(res, 409, 'RECEIPT_ALREADY_USED', 'This receipt has already been submitted.', {
      status: result.transaction.status
    });
  }
  return ok(res, {
    requestId: result.transaction._id,
    amount: Number(amount),
    status: result.verified ? 'COMPLETED' : 'PENDING',
    reason: result.verified ? undefined : result.reason,
    newBalance: result.newBalance
  }, 201);
}));

router.post('/withdraw', rateLimit({ max: 10, windowSeconds: 3600 }), asyncHandler(async (req, res) => {
  const { amount } = req.body || {};
  if (!amount) return fail(res, 400, 'INVALID_AMOUNT', 'amount is required');

  const result = await walletService.requestWithdrawal(req.userId, Number(amount));
  notificationService.emitToUser(req.userId, 'balance_update', { mainWallet: result.availableBalance });
  return ok(res, {
    requestId: result.transaction._id,
    amount: Number(amount),
    status: 'PENDING',
    newBalance: result.availableBalance
  }, 201);
}));

router.get('/transactions', asyncHandler(async (req, res) => {
  const { limit, offset } = paginationParams(req.query);
  const [transactions, total] = await Promise.all([
    Transaction.find({ userId: req.userId }).sort({ timestamp: -1 }).skip(offset).limit(limit),
    Transaction.countDocuments({ userId: req.userId })
  ]);
  return ok(res, {
    transactions,
    pagination: { limit, offset, total, hasMore: offset + transactions.length < total }
  });
}));

module.exports = router;
