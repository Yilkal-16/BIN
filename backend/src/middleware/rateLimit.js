const { checkRateLimit } = require('../utils/redis');
const { fail } = require('../utils/helpers');
const logger = require('../utils/logger');

const WINDOW = Number(process.env.RATE_LIMIT_WINDOW || 200);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 10000);

/**
 * Generic per-user-per-endpoint rate limiter (§10.3). Falls open (allows the
 * request) if Redis is unreachable, per the "degraded performance, not a hard
 * failure" behavior specified for Redis outages (§12).
 */
function rateLimit({ max = MAX_REQUESTS, windowSeconds = WINDOW, keyFn } = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const identity = keyFn ? keyFn(req) : req.userId || req.ip;
      const bucket = `${req.baseUrl}${req.path}:${identity}`;
      const { allowed, remaining } = await checkRateLimit(bucket, windowSeconds, max);
      res.set('X-RateLimit-Remaining', String(remaining));
      if (!allowed) return fail(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many requests, please slow down.');
      next();
    } catch (err) {
      logger.warn('Rate limiter unavailable, allowing request through', { error: err.message });
      next();
    }
  };
}

// Deposit endpoints are limited to 5 attempts/hour specifically (§10.3).
const depositRateLimit = rateLimit({ max: 5, windowSeconds: 3600 });

module.exports = { rateLimit, depositRateLimit };
