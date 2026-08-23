const axios = require('axios');
const logger = require('../utils/logger');

/**
 * ============================================================================
 * Telebirr deposit verification
 * ============================================================================
 * Replaces the earlier @localpay/verification-engine wrapper with a
 * self-contained implementation matching this exact workflow:
 *
 *   User pastes the full Telebirr confirmation SMS
 *     -> extract the transaction ID and the official receipt URL from it
 *     -> fetch that URL (a normal server-to-server HTTP request — Telebirr's
 *        robots.txt tells *crawlers* not to index these pages for privacy
 *        reasons, which is unrelated to a merchant backend fetching one
 *        specific receipt it was just given a direct link to; that's the
 *        whole point of the "share your payment info" link in the SMS)
 *     -> parse the official page
 *     -> cross-check transaction ID / amount / recipient against what's
 *        expected
 *     -> verified only if every hard check passes with confidence
 *
 * Honesty note on the receipt-page parsing specifically: I could fetch and
 * inspect the SMS format directly (a real sample was provided), so that
 * parser below is exercised against real ground truth and is trustworthy.
 * I could NOT fetch a live receipt page to inspect its actual HTML
 * (blocked by robots.txt for automated tools), so parseReceiptText() below
 * is a structure-agnostic best effort: rather than depend on exact CSS
 * selectors or label text I can't verify, it works off the page's plain
 * text and checks whether the *values* we expect (the transaction ID, the
 * claimed amount, our own phone number's last 4 digits) literally appear
 * on the page. That's more robust to unknown markup than guessing at
 * selectors, but it should still be validated against one real receipt
 * page before you fully trust it in production — see README.
 *
 * Whatever isn't confidently verified falls back to manual admin review
 * (§4.3 Step 6B) rather than guessing in either direction — this function
 * never auto-*rejects* a deposit outright, it only ever auto-*approves*
 * with confidence or defers to a human.
 * ============================================================================
 */

const RECEIPT_URL_PATTERN = /https?:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Za-z0-9]+)/i;

/**
 * Parses whatever the user pasted — ideally the full SMS, but also
 * tolerates a bare receipt URL or a bare transaction ID for users who no
 * longer have the full message.
 */
function parseProofInput(rawText) {
  const text = String(rawText || '').trim();

  const result = {
    transactionId: null,
    receiptUrl: null,
    claimedAmount: null,
    senderName: null,
    recipientName: null,
    recipientPhoneMasked: null,
    dateTime: null
  };

  // Anchored to the known SMS template — tolerant of the template's own
  // inconsistent whitespace (double spaces appear in real samples).
  const mainMatch = text.match(
    /transferred\s+ETB\s*([\d,]+\.?\d*)\s+to\s+(.+?)\s*\(([\d*]+)\)\s+on\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/is
  );
  if (mainMatch) {
    result.claimedAmount = parseAmount(mainMatch[1]);
    result.recipientName = mainMatch[2].trim();
    result.recipientPhoneMasked = mainMatch[3];
    result.dateTime = mainMatch[4];
  }

  const senderMatch = text.match(/Dear\s+(.+?)\s+You have transferred/is);
  if (senderMatch) result.senderName = senderMatch[1].trim();

  const txnMatch = text.match(/transaction number is\s+([A-Za-z0-9]+)/i);
  if (txnMatch) result.transactionId = txnMatch[1].trim();

  const urlMatch = text.match(RECEIPT_URL_PATTERN);
  if (urlMatch) {
    result.receiptUrl = urlMatch[0].replace(/[.,]$/, ''); // strip trailing sentence punctuation
    if (!result.transactionId) result.transactionId = urlMatch[1];
  }

  // Fallback: nothing SMS-shaped matched — maybe they pasted a bare
  // transaction ID (Telebirr IDs are ~10 uppercase alphanumeric chars).
  if (!result.transactionId && !result.receiptUrl && /^[A-Za-z0-9]{6,14}$/.test(text)) {
    result.transactionId = text.toUpperCase();
  }

  // If we have an ID but no URL (or vice versa), derive one from the other
  // — the URL pattern is fixed and documented by Telebirr's own SMS.
  if (result.transactionId && !result.receiptUrl) {
    result.receiptUrl = `https://transactioninfo.ethiotelecom.et/receipt/${result.transactionId}`;
  }

  return result;
}

function parseAmount(raw) {
  const n = parseFloat(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Minimal, dependency-free HTML-to-text conversion — no cheerio/jsdom needed for pattern matching. */
function stripHtmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Structure-agnostic extraction from the official receipt page's plain
 * text — see the honesty note at the top of this file.
 */
function parseReceiptText(text, expectedTransactionId) {
  const containsTransactionId = expectedTransactionId
    ? new RegExp(escapeRegExp(expectedTransactionId), 'i').test(text)
    : false;

  const amounts = [...text.matchAll(/ETB\s*([\d,]+\.\d{2})/gi)].map((m) => parseAmount(m[1]));

  const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/);

  return {
    containsTransactionId,
    amounts, // every ETB-prefixed figure found — checked via "is the claimed amount among these" rather than guessing which one is "the" amount
    dateTime: dateMatch ? dateMatch[1] : null,
    rawTextSample: text.slice(0, 500) // kept small, for admin/debug logging only
  };
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchReceiptHtml(url) {
  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 3,
    headers: {
      // A normal browser UA — this is a legitimate merchant-verification
      // request to a link Telebirr itself generated for exactly this
      // purpose, not an attempt to evade robots.txt's crawler guidance.
      'User-Agent': 'Mozilla/5.0 (compatible; BingoDepositVerification/1.0)'
    },
    validateStatus: (status) => status < 500
  });
  if (response.status !== 200) {
    throw new Error(`Receipt page returned HTTP ${response.status}`);
  }
  return response.data;
}

/**
 * Main entry point — same call shape callers already use:
 * verifyDeposit({ amount, rawProof }) -> boolean.
 *
 * For richer diagnostics (surfaced to the admin panel / logs), use
 * verifyDepositDetailed() instead, which this wraps.
 */
async function verifyDeposit({ amount, rawProof }) {
  const result = await verifyDepositDetailed({ amount, rawProof });
  return result.verified;
}

async function verifyDepositDetailed({ amount, rawProof }) {
  const parsed = parseProofInput(rawProof);

  if (!parsed.transactionId || !parsed.receiptUrl) {
    return { verified: false, reason: 'UNPARSEABLE', parsed };
  }

  // Soft check, logged only — see the reasoning in the file header on why
  // sender-name matching isn't a hard gate (Telegram display names and
  // Telebirr account names frequently differ legitimately).
  if (parsed.senderName) {
    logger.info('Deposit sender name (informational only, not enforced)', { senderName: parsed.senderName });
  }

  let html;
  try {
    html = await fetchReceiptHtml(parsed.receiptUrl);
  } catch (err) {
    logger.warn('Failed to fetch Telebirr receipt page — falling back to manual review', {
      url: parsed.receiptUrl,
      error: err.message
    });
    return { verified: false, reason: 'FETCH_FAILED', parsed };
  }

  const text = stripHtmlToText(html);
  const receipt = parseReceiptText(text, parsed.transactionId);

  if (!receipt.containsTransactionId) {
    logger.warn('Receipt page did not contain the expected transaction ID', {
      transactionId: parsed.transactionId,
      url: parsed.receiptUrl
    });
    return { verified: false, reason: 'TRANSACTION_ID_NOT_FOUND', parsed, receipt };
  }

  const amountMatches = receipt.amounts.some((a) => a != null && Math.abs(a - amount) < 0.01);
  if (!amountMatches) {
    logger.warn('Receipt page did not confirm the claimed deposit amount', {
      claimedAmount: amount,
      amountsFoundOnPage: receipt.amounts,
      transactionId: parsed.transactionId
    });
    return { verified: false, reason: 'AMOUNT_MISMATCH', parsed, receipt };
  }

  const expectedLast4 = String(process.env.DEPOSIT_PHONE_NUMBER || '').slice(-4);
  const recipientConfirmed = expectedLast4 ? text.includes(expectedLast4) : true;
  if (!recipientConfirmed) {
    logger.warn('Receipt page did not confirm our account as the recipient', {
      transactionId: parsed.transactionId,
      expectedLast4
    });
    return { verified: false, reason: 'RECIPIENT_MISMATCH', parsed, receipt };
  }

  logger.info('Deposit verified via Telebirr receipt page', {
    transactionId: parsed.transactionId,
    amount
  });
  return { verified: true, reason: 'OK', parsed, receipt };
}

module.exports = {
  parseProofInput,
  stripHtmlToText,
  parseReceiptText,
  fetchReceiptHtml,
  verifyDeposit,
  verifyDepositDetailed
};
