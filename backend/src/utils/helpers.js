const crypto = require('crypto');

/** External Game ID: "BG" + YYMMDD + 3-digit daily sequence, e.g. BG240701001 (§8.1). */
function generateGameId(seq) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const seqStr = String(seq).padStart(3, '0');
  return `BG${yy}${mm}${dd}${seqStr}`;
}

/** Internal transaction reference: "TXN-" + date + 6-digit sequence (§8.1). */
function generateReferenceId(seq) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `TXN-${y}${m}${d}-${String(seq).padStart(6, '0')}`;
}

/** Withdrawal-facing request id: "WD-" + short id (§4.4). */
function generateWithdrawalDisplayId(objectId) {
  return `WD-${String(objectId).slice(-8).toUpperCase()}`;
}

/**
 * §14.1 lists MIN_CARTELAS=150 directly as a settable env var (with the
 * formula below as the *reasoning* for that default, now that v7.1 is a
 * single stake tier and the value no longer needs to vary per-stake the way
 * it would have under multi-stake). Read it directly when set; fall back to
 * computing it from MIN_PRIZE_POOL/HOUSE_COMMISSION/STAKE_AMOUNT so the
 * system still works sensibly if an operator changes the stake without
 * remembering to update MIN_CARTELAS too.
 */
function getMinCartelasForStake(stake) {
  if (process.env.MIN_CARTELAS) return Number(process.env.MIN_CARTELAS);
  const MIN_PRIZE_POOL = Number(process.env.MIN_PRIZE_POOL || 1200);
  const HOUSE_COMMISSION = Number(process.env.HOUSE_COMMISSION || 0.2);
  return Math.ceil(MIN_PRIZE_POOL / (stake * (1 - HOUSE_COMMISSION)));
}

/** Standard success envelope. */
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

/** Standard error envelope (§11.1). */
function fail(res, status, code, message, details = undefined) {
  return res.status(status).json({
    success: false,
    error: { code, message, details, timestamp: new Date().toISOString() }
  });
}

/** Clamp pagination params to documented defaults/max (§8.4/§8.5). */
function paginationParams(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  let limit = parseInt(query.limit, 10);
  let offset = parseInt(query.offset, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Wraps an async Express handler so rejected promises reach errorHandler (Express 4 doesn't do this natively). */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Fisher-Yates shuffle (used for draw sequence generation). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  generateGameId,
  generateReferenceId,
  generateWithdrawalDisplayId,
  getMinCartelasForStake,
  ok,
  fail,
  paginationParams,
  randomToken,
  shuffle,
  asyncHandler
};
