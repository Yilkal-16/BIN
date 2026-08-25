const { Redis } = require('@upstash/redis');
const logger = require('./logger');

/**
 * Primary Redis client (Upstash REST API). Used for:
 *  - distributed locks (e.g. start game)
 *  - rate limiting counters
 *  - admin PIN attempt tracking
 *  - lightweight caching of ephemeral game state
 *
 * REST-based Redis works over plain HTTPS, which is why it's the right choice
 * for the simple key/counter operations below (§2.5 Redis Responsibilities).
 */
const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN
});

/**
 * Acquire a short-lived distributed lock using SET NX PX semantics.
 * Returns a release() function on success, or null if the lock is already held.
 *
 * This is the Redis "Redlock"-style mechanism referenced in §10.4 for
 * "start game" and "auto-allocate" — a single Redis node is sufficient here
 * given the project's free-tier, single-region scale.
 */
async function acquireLock(key, ttlMs = 10000) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lockKey = `lock:${key}`;
  const ok = await redis.set(lockKey, token, { nx: true, px: ttlMs });
  if (!ok) return null;
  return async function release() {
    try {
      // Only release if we still own the lock (avoid clobbering someone else's).
      const current = await redis.get(lockKey);
      if (current === token) await redis.del(lockKey);
    } catch (err) {
      logger.warn('Lock release failed', { key, error: err.message });
    }
  };
}

/**
 * Runs fn() while holding the named lock. If the lock can't be acquired,
 * returns { skipped: true } instead of throwing — callers treat this as
 * "someone else is already handling it right now", which is the expected
 * behavior for start-game/auto-allocate ticks.
 */
async function withLock(key, ttlMs, fn) {
  const release = await acquireLock(key, ttlMs);
  if (!release) return { skipped: true };
  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    await release();
  }
}

/** Sliding-window-ish fixed-window rate limiter. Returns { allowed, remaining }. */
async function checkRateLimit(bucketKey, windowSeconds, maxRequests) {
  const key = `rl:${bucketKey}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return { allowed: count <= maxRequests, remaining: Math.max(0, maxRequests - count) };
}

/** Admin PIN attempt tracking (§10.2 — 5 attempts / 15 minute lockout). */
async function recordAdminPinAttempt(telegramId, success) {
  const key = `${process.env.ADMIN_PIN_ATTEMPTS_KEY || 'admin_pin_attempts'}:${telegramId}`;
  if (success) {
    await redis.del(key);
    return { locked: false, attempts: 0 };
  }
  const attempts = await redis.incr(key);
  if (attempts === 1) await redis.expire(key, 15 * 60);
  return { locked: attempts >= 5, attempts };
}

async function isAdminLockedOut(telegramId) {
  const key = `${process.env.ADMIN_PIN_ATTEMPTS_KEY || 'admin_pin_attempts'}:${telegramId}`;
  const attempts = Number((await redis.get(key)) || 0);
  return attempts >= 5;
}

/**
 * Optional: ioredis client pair for the Socket.IO Redis adapter (pub/sub
 * needs a persistent TCP connection, which the REST client above can't do).
 * This only activates horizontal scaling across multiple backend instances;
 * a single Render instance works perfectly well without it. If REDIS_TCP_URL
 * isn't set, callers should skip the adapter and run standalone.
 */
function createIoredisPairIfConfigured() {
  const tcpUrl = process.env.REDIS_TCP_URL;
  if (!tcpUrl) {
    logger.info('REDIS_TCP_URL not set — Socket.IO running in single-instance mode (no Redis adapter)');
    return null;
  }
  try {
    const IORedis = require('ioredis');
    const pubClient = new IORedis(tcpUrl, { maxRetriesPerRequest: null });
    const subClient = pubClient.duplicate();
    pubClient.on('error', (err) => logger.warn('ioredis pubClient error', { error: err.message }));
    subClient.on('error', (err) => logger.warn('ioredis subClient error', { error: err.message }));
    return { pubClient, subClient };
  } catch (err) {
    logger.warn('Failed to initialize ioredis pair for Socket.IO adapter', { error: err.message });
    return null;
  }
}

module.exports = {
  redis,
  acquireLock,
  withLock,
  checkRateLimit,
  recordAdminPinAttempt,
  isAdminLockedOut,
  createIoredisPairIfConfigured
};
