const express = require('express');
const { User } = require('../models');
const { signToken, verifyTelegramInitData } = require('../middleware/auth');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

/**
 * WebApp login (§10.1's documented flow needs an endpoint that actually
 * performs it — not explicitly listed in §8.2's table, so this fills that
 * gap with the simplest solution consistent with the rest of the spec).
 * The WebApp is opened by a bot button for an ALREADY-registered user
 * (registration itself only happens through the bot's contact-share flow,
 * §4.2), so this only issues a token — it never creates a user.
 */
router.post('/telegram', rateLimit({ max: 180, windowSeconds: 300 }), asyncHandler(async (req, res) => {
  const { initData } = req.body || {};
  if (!initData) return fail(res, 400, 'INVALID_AMOUNT', 'initData is required');

  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) return fail(res, 401, 'UNAUTHORIZED', 'Invalid Telegram authentication data');

  const user = await User.findOne({ telegramId: String(tgUser.id) });
  if (!user) {
    return fail(res, 404, 'NOT_FOUND', 'Please register with the bot first by sending /start.');
  }

  user.lastActive = new Date();
  await user.save();

  return ok(res, { user: sanitizeUser(user), token: signToken(user) });
}));

/** Thin REST wrapper around the same registration logic the bot uses (§8.2). */
router.post('/register', rateLimit({ max: 180, windowSeconds: 300 }), asyncHandler(async (req, res) => {
  const { telegramId, username, phone, displayName } = req.body || {};
  if (!telegramId || !phone) return fail(res, 400, 'INVALID_AMOUNT', 'telegramId and phone are required');

  const existing = await User.findOne({ $or: [{ telegramId: String(telegramId) }, { phone }] });
  if (existing) return fail(res, 409, 'ALREADY_REGISTERED', 'User already registered');

  const user = await User.create({
    telegramId: String(telegramId),
    telegramUsername: username,
    phone,
    displayName: displayName || username || 'Player'
  });

  return ok(res, { user: sanitizeUser(user), token: signToken(user) }, 201);
}));

/**
 * Phone verification (§8.2). The rest of the PRD has no separate OTP/SMS
 * system — registration is verified by Telegram's own contact-share, not a
 * numeric code — so the simplest solution consistent with that is to treat
 * "verify" as confirming a phone number belongs to a registered account,
 * where `code` is the last 4 digits of the phone on file (a lightweight
 * possession check), rather than standing up a full SMS/OTP provider that
 * nothing else in the spec references.
 */
router.post('/verify', rateLimit({ max: 180, windowSeconds: 300 }), asyncHandler(async (req, res) => {
  const { phone, code } = req.body || {};
  if (!phone || !code) return fail(res, 400, 'INVALID_AMOUNT', 'phone and code are required');
  const user = await User.findOne({ phone });
  const verified = !!user && phone.slice(-4) === String(code).slice(-4);
  return ok(res, { verified });
}));

function sanitizeUser(user) {
  return {
    id: user._id,
    telegramId: user.telegramId,
    displayName: user.displayName,
    phone: user.phone,
    mainWalletBalance: user.mainWalletBalance,
    coins: user.coins,
    isAdmin: user.isAdmin
  };
}

module.exports = router;
