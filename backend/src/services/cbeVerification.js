// backend/src/services/cbeVerification.js
const logger = require('../utils/logger');
const { Transaction } = require('../models');

/**
 * ============================================================================
 * Commercial Bank of Ethiopia (CBE) deposit verification — SCREENSHOT-based
 * ============================================================================
 * The player sends a screenshot of the CBE app's "Transaction Completed
 * Successfully" screen. cbeReceiptReader.js transcribes it; the bot handler
 * wraps the transcription with serializeProof() and passes that string in as
 * `rawProof`. This module NEVER trusts the transcription — it re-checks it.
 *
 * Sample receipt text this module is built against:
 *   "ETB 100.00 has been debited from Getenet Tesega Ayele ETB-4311 for
 *    Mekuryaw Bele Tarik ETB-9222 on Sep 24, 2026 04:08 PM with transaction
 *    ID: FT26267X3FP8. Reason: MB Transfer Total Amount Debited: ETB100.61
 *    with Service Charge of ETB0.50, VAT (15%) of ETB0.08 and Disaster
 *    Recovery (5%) of ETB0.03."
 *
 * Unlike the old SMS, this carries a timestamp, so the receipt must be recent.
 * Checks (in order; the first failure becomes `reason`):
 *   1. isCbeReceipt              — it is the CBE success screen
 *   2. amountMatches             — transferred amount == user-entered amount (exact, to the cent)
 *   3. recipientNameMatches      — == CBE_RECIPIENT_NAME
 *   4. recipientAccountMatches   — last 4 digits == last 4 of CBE_RECIPIENT_ACCOUNT_MASKED
 *   5. transactionIdFormatValid  — "FT" + YYDDD + 5 alphanumerics
 *   6. transactionIdDateMatches  — the YYDDD inside the ID is the receipt's date (±1 day)
 *   7. feeArithmeticConsistent   — amount + charge + VAT + disaster recovery == total debited
 *   8. receiptWithinTimeWindow   — receipt time (EAT, UTC+3) within CBE_MAX_AGE_MINUTES (default 10)
 *   9. transactionIdNotUsed      — never used for a previous deposit
 * ============================================================================
 */

// Configured via environment variables (Render dashboard -> Environment).
//   CBE_RECIPIENT_NAME            e.g. "Mekuryaw Bele Tarik"
//   CBE_RECIPIENT_ACCOUNT_MASKED  e.g. "1********9222" — only the last 4 digits are used now
//   CBE_MAX_AGE_MINUTES           optional, default 10
const EXPECTED_RECIPIENT_NAME = process.env.CBE_RECIPIENT_NAME;
const EXPECTED_RECIPIENT_ACCOUNT_MASKED = process.env.CBE_RECIPIENT_ACCOUNT_MASKED;

if (!EXPECTED_RECIPIENT_NAME || !EXPECTED_RECIPIENT_ACCOUNT_MASKED) {
  throw new Error(
    'cbeVerification: missing required environment variables. ' +
    'Please set CBE_RECIPIENT_NAME and CBE_RECIPIENT_ACCOUNT_MASKED ' +
    '(e.g. in the Render service\'s Environment settings).'
  );
}

const EXPECTED_RECIPIENT_LAST4 = String(EXPECTED_RECIPIENT_ACCOUNT_MASKED).trim().slice(-4);
if (!/^\d{4}$/.test(EXPECTED_RECIPIENT_LAST4)) {
  throw new Error('cbeVerification: CBE_RECIPIENT_ACCOUNT_MASKED must end in 4 digits (e.g. "1********9222").');
}

const PROOF_SOURCE = 'cbe-screenshot';
// "FT" + 2-digit year + 3-digit day-of-year + 5 alphanumerics, e.g. FT26267X3FP8
const TRANSACTION_ID_FORMAT = /^FT(\d{2})(\d{3})[A-Z0-9]{5}$/;
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPT_AGE_MS = Number(process.env.CBE_MAX_AGE_MINUTES || 10) * 60 * 1000;
// The bank's clock can run ahead of the phone's (seen: ~1 min), so allow a little "future".
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Wraps the reader's output into the string stored/passed around as `rawProof`. */
function serializeProof(fields, fileId) {
  return JSON.stringify({ src: PROOF_SOURCE, v: 1, fileId: fileId || null, fields: fields || null });
}

function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** "Sep 24, 2026 04:08 PM" (printed in EAT) -> epoch ms, or null. */
function parseReceiptTime(text) {
  const m = String(text || '').trim().match(
    /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  let hour = Number(m[4]) % 12;
  if (m[6].toUpperCase() === 'PM') hour += 12;
  const ms = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - EAT_OFFSET_MS;
  return Number.isFinite(ms) ? ms : null;
}

/** Normalize name for comparison (case-insensitive, collapse spaces). */
function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function last4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Turns the serialized proof back into normalized fields. Never throws. */
function parseProofInput(rawProof) {
  const result = {
    transactionId: null,
    claimedAmountCents: null,
    totalDebitedCents: null,
    serviceChargeCents: null,
    vatCents: null,
    disasterRecoveryCents: null,
    recipientName: null,
    recipientAccountLast4: null,
    receiptTimeMs: null,
    isCbeReceipt: false,
    fileId: null,
    receiptUrl: null // kept for callers written against the SMS version
  };

  let data;
  try {
    data = JSON.parse(String(rawProof || ''));
  } catch (_) {
    return result;
  }
  if (!data || data.src !== PROOF_SOURCE) return result;

  result.fileId = data.fileId || null;
  const f = data.fields;
  if (!f || typeof f !== 'object') return result;

  result.isCbeReceipt = f.isCbeReceipt === true;
  result.transactionId = f.transactionId ? String(f.transactionId).replace(/\s+/g, '').toUpperCase() : null;
  result.claimedAmountCents = toCents(f.amount);
  result.totalDebitedCents = toCents(f.totalDebited);
  result.serviceChargeCents = toCents(f.serviceCharge);
  result.vatCents = toCents(f.vat);
  result.disasterRecoveryCents = toCents(f.disasterRecovery);
  result.recipientName = f.recipientName ? String(f.recipientName).trim().replace(/[.,،;:]+$/, '').trim() : null;
  result.recipientAccountLast4 = last4(f.recipientAccountLast4);
  result.receiptTimeMs = parseReceiptTime(f.dateTimeText);
  return result;
}

/** The YYDDD inside "FT26267…" must be the receipt's own date (±1 day for midnight edge cases). */
function transactionIdDateMatches(transactionId, receiptTimeMs) {
  const m = TRANSACTION_ID_FORMAT.exec(transactionId || '');
  if (!m || receiptTimeMs == null) return false;
  const eat = new Date(receiptTimeMs + EAT_OFFSET_MS);
  const receiptDayMs = Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate());
  const idDayMs = Date.UTC(2000 + Number(m[1]), 0, 0) + Number(m[2]) * DAY_MS; // Dec 31 + day-of-year
  return Math.abs(idDayMs - receiptDayMs) <= DAY_MS;
}

function feeArithmeticConsistent(p) {
  const parts = [p.claimedAmountCents, p.serviceChargeCents, p.vatCents, p.disasterRecoveryCents, p.totalDebitedCents];
  if (parts.some((v) => v === null)) return false;
  const sum = p.claimedAmountCents + p.serviceChargeCents + p.vatCents + p.disasterRecoveryCents;
  return Math.abs(sum - p.totalDebitedCents) <= 1; // 1 cent of rounding slack
}

/** Check if this transaction ID is already used in another deposit (either method). */
async function isTransactionIdAlreadyUsed(transactionId, excludeTransactionId) {
  const query = { receiptNumber: `CBE-${transactionId}` };
  if (excludeTransactionId) query._id = { $ne: excludeTransactionId };
  const existing = await Transaction.findOne(query).select('_id');
  return !!existing;
}

/** Main entry point — returns boolean verification result. */
async function verifyDeposit({ amount, rawProof, currentTransactionId }) {
  const result = await verifyDepositDetailed({ amount, rawProof, currentTransactionId });
  return result.verified;
}

/** Runs all checks against extracted fields and returns a detailed result. `nowMs` is injectable for tests. */
async function verifyDepositDetailed({ amount, rawProof, currentTransactionId, nowMs = Date.now() }) {
  const parsed = parseProofInput(rawProof);

  const hasAllFields = !!(
    parsed.transactionId &&
    parsed.claimedAmountCents != null &&
    parsed.recipientName &&
    parsed.recipientAccountLast4 &&
    parsed.receiptTimeMs != null
  );

  if (!hasAllFields) {
    logger.warn('CBE deposit screenshot could not be parsed (missing required fields)', {
      hasTransactionId: !!parsed.transactionId,
      hasAmount: parsed.claimedAmountCents != null,
      hasRecipientName: !!parsed.recipientName,
      hasAccount: !!parsed.recipientAccountLast4,
      hasReceiptTime: parsed.receiptTimeMs != null,
      fileId: parsed.fileId
    });
    return { verified: false, reason: 'UNPARSEABLE', parsed, checks: null };
  }

  const ageMs = nowMs - parsed.receiptTimeMs;
  const checks = {
    isCbeReceipt: parsed.isCbeReceipt,
    amountMatches: parsed.claimedAmountCents === Math.round(Number(amount) * 100),
    recipientNameMatches: normalizeName(parsed.recipientName) === normalizeName(EXPECTED_RECIPIENT_NAME),
    recipientAccountMatches: parsed.recipientAccountLast4 === EXPECTED_RECIPIENT_LAST4,
    transactionIdFormatValid: TRANSACTION_ID_FORMAT.test(parsed.transactionId),
    transactionIdDateMatches: transactionIdDateMatches(parsed.transactionId, parsed.receiptTimeMs),
    feeArithmeticConsistent: feeArithmeticConsistent(parsed),
    receiptWithinTimeWindow: ageMs <= MAX_RECEIPT_AGE_MS && ageMs >= -MAX_CLOCK_SKEW_MS
  };
  // Only hit the database once the cheap checks pass and the ID is well-formed.
  checks.transactionIdNotUsed =
    Object.values(checks).every(Boolean) &&
    !(await isTransactionIdAlreadyUsed(parsed.transactionId, currentTransactionId));

  const verified = Object.values(checks).every(Boolean);
  const reason = verified ? 'OK' : Object.keys(checks).find((k) => !checks[k]).toUpperCase();

  if (!verified) {
    logger.warn('CBE deposit failed screenshot verification, falling back to manual review', {
      transactionId: parsed.transactionId,
      amount,
      reason,
      checks,
      parsedRecipientName: parsed.recipientName,
      receiptAgeSeconds: Math.round(ageMs / 1000),
      fileId: parsed.fileId
    });
  } else {
    logger.info('CBE deposit auto-verified from screenshot', {
      transactionId: parsed.transactionId,
      amount,
      fileId: parsed.fileId
    });
  }

  return { verified, reason, parsed, checks };
}

module.exports = {
  EXPECTED_RECIPIENT_NAME,
  EXPECTED_RECIPIENT_ACCOUNT_MASKED,
  TRANSACTION_ID_FORMAT,
  RECEIPT_SLUG_FORMAT: TRANSACTION_ID_FORMAT, // back-compat alias
  serializeProof,
  parseProofInput,
  parseReceiptTime,
  isTransactionIdAlreadyUsed,
  verifyDeposit,
  verifyDepositDetailed
};
