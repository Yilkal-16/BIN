// backend/src/services/cbeReceiptReader.js
const logger = require('../utils/logger');

/**
 * Reads a CBE mobile-banking "Transaction Completed Successfully" screenshot
 * with FREE, local OCR (tesseract.js) — no paid API, no API key.
 * Returns the printed fields as plain data. It makes NO trust decisions —
 * every value is re-validated by cbeVerification.js. If OCR misreads or a
 * field is missing, verification simply fails and the deposit goes to manual review.
 *
 * Install once:  npm install tesseract.js
 * (Downloads the small English language file from a CDN on first use.)
 */

const OCR_TIMEOUT_MS = 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js'); // lazy: no cost until the first CBE deposit
    workerPromise = createWorker('eng').catch((err) => {
      workerPromise = null; // allow a retry on the next deposit
      throw err;
    });
  }
  return workerPromise;
}

// OCR often reads the digit 0 as the letter O right after "ETB" ("ETBO.50"), so accept both.
const AMT = '([\\dOo,]+\\.[\\dOo]{1,2})';

/** Pure text -> fields. Exported for testing. */
function parseReceiptText(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  const grab = (re) => {
    const m = text.match(re);
    return m ? m[1] : null;
  };
  const num = (v) => {
    if (v === null) return null;
    const n = Number(v.replace(/,/g, '').replace(/[Oo]/g, '0'));
    return Number.isFinite(n) ? n : null;
  };

  const parties = text.match(
    /debited\s+from\s+(.+?)\s+ETB\s*[-–]?\s*(\d{4})\s+for\s+(.+?)\s+ETB\s*[-–]?\s*(\d{4})\s+on\s/i
  );

  return {
    isCbeReceipt: /debited\s+from/i.test(text) && /transaction\s*id/i.test(text),
    amount: num(grab(new RegExp(`ETB\\s*${AMT}\\s+has\\s+been\\s+debited`, 'i'))),
    totalDebited: num(grab(new RegExp(`Total\\s+Amount\\s+Debited:?\\s*ETB\\s*${AMT}`, 'i'))),
    serviceCharge: num(grab(new RegExp(`Service\\s+Charge\\s+of\\s+ETB\\s*${AMT}`, 'i'))),
    vat: num(grab(new RegExp(`VAT\\s*\\(\\d+%\\)\\s*of\\s*ETB\\s*${AMT}`, 'i'))),
    disasterRecovery: num(grab(new RegExp(`Disaster\\s+Recovery\\s*\\(\\d+%\\)\\s*of\\s*ETB\\s*${AMT}`, 'i'))),
    senderName: parties ? parties[1].trim() : null,
    senderAccountLast4: parties ? parties[2] : null,
    recipientName: parties ? parties[3].trim() : null,
    recipientAccountLast4: parties ? parties[4] : null,
    dateTimeText: grab(/\son\s+([A-Za-z]{3,9}\.?\s+\d{1,2},\s*\d{4}\s+\d{1,2}:\d{2}\s*[AaPp][Mm])\s+with/i),
    transactionId: grab(/transaction\s*ID:?\s*([A-Za-z0-9]{8,16})/i)
  };
}

async function readCbeReceipt(buffer, mediaType) {
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) throw new Error(`cbeReceiptReader: unsupported media type ${mediaType}`);
  if (!buffer || !buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('cbeReceiptReader: image missing or larger than 5 MB');
  }
  try {
    const worker = await getWorker();
    const result = await Promise.race([
      worker.recognize(buffer),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), OCR_TIMEOUT_MS).unref())
    ]);
    return parseReceiptText(result.data.text);
  } catch (err) {
    logger.error('CBE receipt screenshot could not be read', { message: err.message });
    throw err;
  }
}

module.exports = { readCbeReceipt, parseReceiptText, ALLOWED_MEDIA_TYPES, MAX_IMAGE_BYTES };
