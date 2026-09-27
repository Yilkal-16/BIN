// backend/src/services/cbeVerification.js
const logger = require('../utils/logger');
const { Transaction } = require('../models');

/**
 * ============================================================================
 * Commercial Bank of Ethiopia (CBE) deposit verification — SMS-only
 * ============================================================================
 * Sample CBE confirmation SMS this module is built against:
 *
 *   "Dear Getenet Tesega Ayele You have successfully transferred ETB300.00
 *    from account 1********4311 to account 1********9222 (Mekuryaw Bele
 *    Tarik). Service charge of ETB 0.50 and VAT(15%) of ETB0.08 and
 *    Disaster Recovery(5%) of 0.03 with total of ETB300.61 .Your current
 *    balance is ETB106,415.95. Thanks for Banking with CBE.
 *    https://mbreciept.cbe.com.et/v2-hfHCxHahH2TnGnnDqWpC
 *    for feedback: https://forms.gle/kGNGQpG3mQCCk3iD6"
 *
 * Unlike Telebirr, CBE's SMS carries no timestamp, so there is no
 * within-10-minutes check here — replay protection instead relies entirely
 * on the receipt-URL slug being a single-use, unguessable per-transaction
 * token (checked #4/#5 below).
 *
 * Four checks run against extracted data:
 *   1. Amount            — the transferred amount matches the user-entered amount
 *   2. Recipient account — masked "to account" number must equal CBE_RECIPIENT_ACCOUNT_MASKED
 *   3. Recipient name    — the name in parentheses must equal CBE_RECIPIENT_NAME
 *   4. Receipt slug      — must be present, well-formed, and not already used
 * ============================================================================
 */

// Configured via environment variables (Render dashboard -> service ->
// Environment), same pattern as TELEBIRR_RECIPIENT_NAME / _PHONE_MASKED.
//   CBE_RECIPIENT_NAME            e.g. "Mekuryaw Bele Tarik"
//   CBE_RECIPIENT_ACCOUNT_MASKED  e.g. "1********9222" (exactly as it appears in the SMS)
const EXPECTED_RECIPIENT_NAME = process.env.CBE_RECIPIENT_NAME;
const EXPECTED_RECIPIENT_ACCOUNT_MASKED = process.env.CBE_RECIPIENT_ACCOUNT_MASKED;
// CBE's receipt slugs (e.g. "v2-hfHCxHahH2TnGnnDqWpC") mix case and hyphens,
// unlike Telebirr's fixed-format uppercase-alphanumeric transaction IDs.
const RECEIPT_SLUG_FORMAT = /^[A-Za-z0-9-]{8,40}$/;

if (!EXPECTED_RECIPIENT_NAME || !EXPECTED_RECIPIENT_ACCOUNT_MASKED) {
  throw new Error(
    'cbeVerification: missing required environment variables. ' +
    'Please set CBE_RECIPIENT_NAME and CBE_RECIPIENT_ACCOUNT_MASKED ' +
    '(e.g. in the Render service\'s Environment settings).'
  );
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "to account 1********9222 (Mekuryaw Bele Tarik)" — account number and
// recipient name are extracted together in one anchored match, exactly
// like Telebirr's phone+name pattern, so a genuine SMS to a *different*
// CBE account never accidentally passes the name check.
const RECIPIENT_REGEX = new RegExp(
  `to\\s+account\\s+${escapeRegex(EXPECTED_RECIPIENT_ACCOUNT_MASKED)}\\s*\\(([^)]+)\\)`,
  'i'
);

/**
 * Extracts fields individually from the SMS text.
 */
function parseProofInput(rawText) {
  const text = String(rawText || '').trim();

  const result = {
    transactionId: null,
    claimedAmount: null,
    recipientName: null,
    recipientAccountMasked: null,
    receiptUrl: null
  };

  // ---- 1. Extract Amount ----
  // "You have successfully transferred ETB300.00 from account ..."
  // Anchored on "transferred" so this never picks up the service charge,
  // VAT, Disaster Recovery, running-total, or current-balance figures that
  // also appear as "ETB..." amounts later in the same message.
  const amountMatch = text.match(/transferred\s+ETB\s*([\d,]+\.\d+)/i)?.[1];
  if (amountMatch) {
    result.claimedAmount = parseAmount(amountMatch);
  }

  // ---- 2. Extract Recipient account + name together ----
  const recipientMatch = text.match(RECIPIENT_REGEX);
  if (recipientMatch) {
    result.recipientAccountMasked = EXPECTED_RECIPIENT_ACCOUNT_MASKED;
    result.recipientName = recipientMatch[1].trim().replace(/[.,،;:]+$/, '').trim();
  }

  // ---- 3. Extract Receipt URL / slug (doubles as the transaction ID) ----
  const urlMatch = text.match(/https:\/\/mbreciept\.cbe\.com\.et\/([A-Za-z0-9-]+)/i);
  if (urlMatch) {
    result.receiptUrl = urlMatch[0];
    result.transactionId = urlMatch[1];
  }

  return result;
}

/** Parse amount string to a whole-Birr number (handles comma thousands separators). */
function parseAmount(raw) {
  const n = parseFloat(String(raw).replace(/,/g, ''));
  // Whole-Birr rule: this platform never carries a fractional balance, so
  // round to the nearest Birr before comparing against the (already whole)
  // user-entered amount.
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Normalize name for comparison (case-insensitive, trim spaces). */
function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Check if this receipt slug is already used in another deposit (either method). */
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

/** Runs all checks against extracted fields and returns a detailed result. */
async function verifyDepositDetailed({ amount, rawProof, currentTransactionId }) {
  const parsed = parseProofInput(rawProof);

  const hasAllFields = !!(
    parsed.transactionId &&
    parsed.claimedAmount != null &&
    parsed.recipientName &&
    parsed.recipientAccountMasked
  );

  if (!hasAllFields) {
    logger.warn('CBE deposit SMS could not be parsed (missing required fields)', {
      hasTransactionId: !!parsed.transactionId,
      hasAmount: parsed.claimedAmount != null,
      hasRecipientName: !!parsed.recipientName,
      hasAccount: !!parsed.recipientAccountMasked,
      rawProofPreview: rawProof.substring(0, 100) + '...'
    });
    return { verified: false, reason: 'UNPARSEABLE', parsed, checks: null };
  }

  const checks = {
    amountMatches: parsed.claimedAmount === amount,
    recipientNameMatches: normalizeName(parsed.recipientName) === normalizeName(EXPECTED_RECIPIENT_NAME),
    receiptSlugFormatValid: RECEIPT_SLUG_FORMAT.test(parsed.transactionId),
    receiptSlugNotUsed: !(await isTransactionIdAlreadyUsed(parsed.transactionId, currentTransactionId))
  };

  const verified = Object.values(checks).every(Boolean);
  const reason = verified ? 'OK' : Object.keys(checks).find((k) => !checks[k]).toUpperCase();

  if (!verified) {
    logger.warn('CBE deposit failed SMS verification, falling back to manual review', {
      transactionId: parsed.transactionId,
      amount,
      reason,
      checks,
      parsedRecipientName: parsed.recipientName,
      receiptUrl: parsed.receiptUrl
    });
  } else {
    logger.info('CBE deposit auto-verified from SMS', {
      transactionId: parsed.transactionId,
      amount,
      receiptUrl: parsed.receiptUrl
    });
  }

  return { verified, reason, parsed, checks };
}

module.exports = {
  EXPECTED_RECIPIENT_NAME,
  EXPECTED_RECIPIENT_ACCOUNT_MASKED,
  RECEIPT_SLUG_FORMAT,
  parseProofInput,
  isTransactionIdAlreadyUsed,
  verifyDeposit,
  verifyDepositDetailed
};
