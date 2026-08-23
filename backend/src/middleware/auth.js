const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { fail } = require('../utils/helpers');
const { User } = require('../models');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

function signToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), telegramId: user.telegramId, isAdmin: !!user.isAdmin },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Validates Telegram WebApp initData using the bot token per Telegram's
 * documented HMAC scheme (10.1). Returns the parsed user payload if valid,
 * or null if the signature doesn't check out.
 */
function verifyTelegramInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) return null;

    const userJson = params.get('user');
    return userJson ? JSON.parse(userJson) : null;
  } catch (err) {
    logger.warn('Telegram initData verification failed', { error: err.message });
    return null;
  }
}

/** Express middleware: requires a valid JWT in the Authorization header. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 401, 'UNAUTHORIZED', 'Authentication required');

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (!user) return fail(res, 401, 'UNAUTHORIZED', 'User not found');
    req.user = user;
    req.userId = user._id.toString();
    next();
  } catch (err) {
    return fail(res, 401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
}

/** Express middleware: requires the authenticated user to be an admin. */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return fail(res, 403, 'FORBIDDEN', 'Admin access required');
  next();
}

/** Socket.IO middleware: validates the JWT passed in the handshake auth object. */
async function socketAuthMiddleware(socket, next) {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('UNAUTHORIZED'));
    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (!user) return next(new Error('UNAUTHORIZED'));
    socket.userId = user._id.toString();
    socket.isAdmin = !!user.isAdmin;
    next();
  } catch (err) {
    next(new Error('UNAUTHORIZED'));
  }
}

module.exports = {
  signToken,
  verifyToken,
  verifyTelegramInitData,
  requireAuth,
  requireAdmin,
  socketAuthMiddleware
};
