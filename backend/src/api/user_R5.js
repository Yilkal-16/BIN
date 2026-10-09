const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ok, fail, asyncHandler } = require('../utils/helpers');

const router = express.Router();
router.use(requireAuth);

router.get('/profile', asyncHandler(async (req, res) => {
  const u = req.user;
  return ok(res, {
    user: {
      id: u._id,
      telegramId: u.telegramId,
      displayName: u.displayName,
      phone: u.phone,
      walletAddress: u.walletAddress,
      mainWalletBalance: u.mainWalletBalance,
      coins: u.coins,
      isAdmin: u.isAdmin,
      totalGamesPlayed: u.totalGamesPlayed,
      totalWins: u.totalWins,
      totalWinnings: u.totalWinnings
    }
  });
}));

router.put('/profile', asyncHandler(async (req, res) => {
  const { displayName, walletAddress } = req.body || {};
  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 64) {
      return fail(res, 400, 'INVALID_AMOUNT', 'displayName must be a non-empty string up to 64 characters');
    }
    req.user.displayName = displayName.trim();
  }
  if (walletAddress !== undefined) req.user.walletAddress = walletAddress;
  await req.user.save();
  return ok(res, { user: { displayName: req.user.displayName, walletAddress: req.user.walletAddress } });
}));

module.exports = router;
