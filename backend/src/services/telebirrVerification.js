// backend/src/services/telebirrVerification.js
const logger = require('../utils/logger');
const { Transaction } = require('../models');

/**
 * ============================================================================
 * Telebirr deposit verification — SMS-only (Bilingual)
 * ============================================================================
 * Extracts fields individually from the SMS text using language-agnostic
 * patterns. Works for both English and Amharic SMS formats.
 *
 * Field extraction order (each field extracted independently):
 *   1. Transaction ID   - /transaction number is/i or /የሂሳብ እንቅስቃሴ ቁጥርዎ/i
 *   2. Phone            - /\((2519\*{4}1508)\)/ (exact match, both languages)
 *   3. Date & Time      - /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/
 *   4. Amount           - /ETB\s*([\d,]+\.\d+)/i or /([\d,]+\.\d+)\s*ብር/
 *   5. Recipient Name   - /to\s+(.+?)\s*\(2519/i or /ወደ\s+(.+?)\s*\(2519/i
 *   6. Receipt URL      - /https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/[A-Z0-9]+/i
 *
 * Six checks run against extracted data:
 *   1. Amount        — claimed amount matches user-entered amount
 *   2. Recipient name — must equal "Getenet Tesege" (case-insensitive)
 *   3. Recipient phone — must equal "2519****1508"
 *   4. Transaction ID  — must be valid format (8-15 uppercase alphanumeric)
 *   5. Transaction ID  — must not already be used
 *   6. Date & time     — must be within 45 minutes
 * ============================================================================
 */

// ---- Hard-coded business constants ----
const EXPECTED_RECIPIENT_NAME = 'Getenet Tesege';
const EXPECTED_RECIPIENT_PHONE_MASKED = '2519****1508';
const MAX_TRANSACTION_AGE_MINUTES = 45;
const TRANSACTION_ID_FORMAT = /^[A-Z0-9]{8,15}$/i;

/**
 * Extracts fields individually from the SMS text.
 * Language-agnostic — works for both English and Amharic.
 */
function parseProofInput(rawText) {
  const text = String(rawText || '').trim();

  const result = {
    transactionId: null,
    claimedAmount: null,
    recipientName: null,
    recipientPhoneMasked: null,
    dateTime: null,
    receiptUrl: null
  };

  // ---- 1. Extract Transaction ID ----
  // English: "transaction number is DGK437T0AK"
  // Amharic: "የሂሳብ እንቅስቃሴ ቁጥርዎ DGN76DJAH7"
  // Amharic alternative: "የግብይት ቁጥርዎ DGN76DJAH7"
  const txIdMatch = 
    text.match(/transaction number is\s*([A-Z0-9]+)/i)?.[1] ||
    text.match(/የሂሳብ\s+እንቅስቃሴ\s+ቁጥርዎ\s*([A-Z0-9]+)/)?.[1] ||
    text.match(/የግብይት\s+ቁጥርዎ\s*([A-Z0-9]+)/)?.[1];
  
  if (txIdMatch) {
    result.transactionId = txIdMatch.toUpperCase();
  }

  // ---- 2. Extract Phone (with capturing group) ----
  // Same format in both languages: (2519****1508)
  const phoneMatch = text.match(/\((2519\*{4}1508)\)/)?.[1];
  if (phoneMatch) {
    result.recipientPhoneMasked = phoneMatch;
  }

  // ---- 3. Extract Date & Time ----
  // English: "on 20/07/2026 16:52:48"
  // Amharic: "በ 23/07/2026 15:46:05"
  const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/)?.[1];
  if (dateMatch) {
    result.dateTime = dateMatch;
  }

  // ---- 4. Extract Amount ----
  // English: "ETB 100.00"
  // Amharic: "400.00 ብር"
  const amountMatch = 
    text.match(/ETB\s*([\d,]+\.\d+)/i)?.[1] ||
    text.match(/([\d,]+\.\d+)\s*ብር/)?.[1];
  
  if (amountMatch) {
    result.claimedAmount = parseAmount(amountMatch);
  }

  // ---- 5. Extract Recipient Name ----
  // English: "to Getenet Tesege (2519****1508)"
  // Amharic: "ወደ Getenet Tesege(2519****1508)"
  const recipientMatch = 
    text.match(/to\s+(.+?)\s*\(2519/i)?.[1] ||
    text.match(/ወደ\s+(.+?)\s*\(2519/i)?.[1];
  
  if (recipientMatch) {
    // Clean up trailing punctuation/spaces
    result.recipientName = recipientMatch.trim().replace(/[.,،;:]+$/, '').trim();
  }

  // ---- 6. Extract Receipt URL ----
  const urlMatch = text.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/[A-Z0-9]+/i)?.[0];
  if (urlMatch) {
    result.receiptUrl = urlMatch;
    // If we don't have a transaction ID yet, extract from URL
    if (!result.transactionId) {
      const urlTxMatch = urlMatch.match(/\/receipt\/([A-Z0-9]+)/i)?.[1];
      if (urlTxMatch) {
        result.transactionId = urlTxMatch.toUpperCase();
      }
    }
  }

  // ---- Fallback: bare transaction ID ----
  if (!result.transactionId && /^[A-Z0-9]{8,15}$/i.test(text.trim())) {
    result.transactionId = text.trim().toUpperCase();
  }

  return result;
}

/**
 * Parse amount string to number (handles comma thousands separators)
 */
function parseAmount(raw) {
  const n = parseFloat(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize phone number for comparison
 */
function normalizePhone(masked) {
  return String(masked || '').replace(/\s+/g, '').toUpperCase();
}

/**
 * Normalize name for comparison (case-insensitive, trim spaces)
 */
function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Parses the SMS "DD/MM/YYYY HH:mm:ss" timestamp into a Date.
 * Telebirr SMS timestamps are in East Africa Time (UTC+3, no DST).
 */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

function parseSmsDateTime(dateTimeStr) {
  const m = String(dateTimeStr || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, HH, MM, SS] = m;
  const utcMs = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(HH), Number(MM), Number(SS)) - EAT_OFFSET_MS;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Check if transaction is within 45-minute window (with 5-min clock skew allowance)
 */
function isWithinMaxAge(date) {
  if (!date) return false;
  const ageMs = Date.now() - date.getTime();
  return ageMs <= MAX_TRANSACTION_AGE_MINUTES * 60 * 1000 && ageMs >= -5 * 60 * 1000;
}

/**
 * Check if transaction ID is already used in another deposit
 */
async function isTransactionIdAlreadyUsed(transactionId, excludeTransactionId) {
  const query = { receiptNumber: transactionId };
  if (excludeTransactionId) query._id = { $ne: excludeTransactionId };
  const existing = await Transaction.findOne(query).select('_id');
  return !!existing;
}

/**
 * Main entry point — returns boolean verification result
 */
async function verifyDeposit({ amount, rawProof, currentTransactionId }) {
  const result = await verifyDepositDetailed({ amount, rawProof, currentTransactionId });
  return result.verified;
}

/**
 * Runs all 6 checks against extracted fields and returns detailed result
 */
async function verifyDepositDetailed({ amount, rawProof, currentTransactionId }) {
  const parsed = parseProofInput(rawProof);

  // Check if all required fields were extracted
  const hasAllFields = !!(
    parsed.transactionId &&
    parsed.claimedAmount != null &&
    parsed.recipientName &&
    parsed.recipientPhoneMasked &&
    parsed.dateTime
  );

  if (!hasAllFields) {
    logger.warn('Deposit SMS could not be parsed (missing required fields)', {
      hasTransactionId: !!parsed.transactionId,
      hasAmount: parsed.claimedAmount != null,
      hasRecipientName: !!parsed.recipientName,
      hasPhone: !!parsed.recipientPhoneMasked,
      hasDateTime: !!parsed.dateTime,
      rawProofPreview: rawProof.substring(0, 100) + '...'
    });
    return { verified: false, reason: 'UNPARSEABLE', parsed, checks: null };
  }

  // Parse the extracted date/time
  const parsedDateTime = parseSmsDateTime(parsed.dateTime);

  // Run all 6 checks
  const checks = {
    amountMatches: Math.abs(parsed.claimedAmount - amount) < 0.01,
    recipientNameMatches: normalizeName(parsed.recipientName) === normalizeName(EXPECTED_RECIPIENT_NAME),
    recipientPhoneMatches: normalizePhone(parsed.recipientPhoneMasked) === normalizePhone(EXPECTED_RECIPIENT_PHONE_MASKED),
    transactionIdFormatValid: TRANSACTION_ID_FORMAT.test(parsed.transactionId),
    transactionIdNotUsed: !(await isTransactionIdAlreadyUsed(parsed.transactionId, currentTransactionId)),
    withinTimeWindow: isWithinMaxAge(parsedDateTime)
  };

  // All checks must pass for verification
  const verified = Object.values(checks).every(Boolean);
  const reason = verified ? 'OK' : Object.keys(checks).find((k) => !checks[k]).toUpperCase();

  if (!verified) {
    logger.warn('Deposit failed SMS verification, falling back to manual review', {
      transactionId: parsed.transactionId,
      amount,
      reason,
      checks,
      parsedRecipientName: parsed.recipientName,
      parsedRecipientPhoneMasked: parsed.recipientPhoneMasked,
      parsedDateTime: parsed.dateTime,
      parsedDateTimeAsUTC: parsedDateTime ? parsedDateTime.toISOString() : null,
      receiptUrl: parsed.receiptUrl
    });
  } else {
    logger.info('Deposit auto-verified from SMS', { 
      transactionId: parsed.transactionId, 
      amount,
      receiptUrl: parsed.receiptUrl
    });
  }

  return { verified, reason, parsed, checks };
}

module.exports = {
  EXPECTED_RECIPIENT_NAME,
  EXPECTED_RECIPIENT_PHONE_MASKED,
  MAX_TRANSACTION_AGE_MINUTES,
  TRANSACTION_ID_FORMAT,
  parseProofInput,
  parseSmsDateTime,
  isTransactionIdAlreadyUsed,
  verifyDeposit,
  verifyDepositDetailed
};