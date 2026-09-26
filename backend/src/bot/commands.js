const { User, UserState, AdminRequest, Transaction, HouseWallet, Game, DrawSequence } = require('../models');
const walletService = require('../services/walletService');
const notificationService = require('../services/notificationService');
const reportingService = require('../services/reportingService');
const simulatorService = require('../services/simulatorService');
const { redis, recordAdminPinAttempt, isAdminLockedOut } = require('../utils/redis');
const { STAKES } = require('../utils/helpers');
const logger = require('../utils/logger');
const kb = require('./keyboards');
const cbeVerification = require('../services/cbeVerification');
const { readCbeReceipt, ALLOWED_MEDIA_TYPES, MAX_IMAGE_BYTES } = require('../services/cbeReceiptReader');

const WEBAPP_URL = process.env.WEBAPP_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const DEPOSIT_PHONE = process.env.DEPOSIT_PHONE_NUMBER || '0911587568';
// Two different CBE env vars, two different jobs:
//  - CBE_RECIPIENT_ACCOUNT_MASKED: the masked form ("1********9222") — only its
//    last 4 digits are used, by cbeVerification.js, to match the account shown
//    on the receipt screenshot. Never shown to anyone.
//  - CBE_RECIPIENT_ACCOUNT: the real, full account number depositors are
//    told to send money to.
const CBE_ACCOUNT = process.env.CBE_RECIPIENT_ACCOUNT || '';
const CBE_ACCOUNT_NAME = process.env.CBE_RECIPIENT_NAME || 'Mekuryaw Bele Tarik';
const DEPOSIT_MIN = Number(process.env.DEPOSIT_MIN_AMOUNT || 50);
const DEPOSIT_MAX = Number(process.env.DEPOSIT_MAX_AMOUNT || 50000);
const WITHDRAW_MIN = Number(process.env.WITHDRAW_MIN_AMOUNT || 50);
const WITHDRAW_MAX = Number(process.env.WITHDRAW_MAX_AMOUNT || 10000);
const VERIFY_TIMEOUT_MS = Number(process.env.TELEBIRR_VERIFICATION_TIMEOUT || 120) * 1000;
// Items per page for the paginated admin lists (Pending Deposits / Pending
// Withdrawals) — each item is its own Telegram message (with its own
// approve/decline buttons), so this is kept small to avoid flooding the chat.
const ADMIN_PAGE_SIZE = 5;

async function getUser(telegramId) {
  return User.findOne({ telegramId: String(telegramId) });
}

async function setState(telegramId, action, data = {}) {
  await UserState.findOneAndUpdate(
    { userId: String(telegramId) },
    { action, data },
    { upsert: true, new: true }
  );
}

async function clearState(telegramId) {
  await UserState.findOneAndUpdate({ userId: String(telegramId) }, { action: null, data: {} }, { upsert: true });
}

async function getState(telegramId) {
  return UserState.findOne({ userId: String(telegramId) });
}

async function isAdminVerified(telegramId) {
  const flag = await redis.get(`admin_verified:${telegramId}`);
  return !!flag;
}

/**
 * Several handlers are now reachable two ways: an inline button tap
 * (callback query) or a persistent-menu reply-keyboard tap (plain text
 * message). Only callback queries have a query to acknowledge.
 */
async function ack(ctx) {
  if (ctx.callbackQuery) await ctx.answerCbQuery();
}

// ---------------------------------------------------------------------------
// Registration (§4.2)
// ---------------------------------------------------------------------------

async function handleStart(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);

  if (!user) {
    await ctx.reply(
      '👋 *Welcome to Bingo!*\nPlay 75-ball Bingo right inside Telegram.',
      { parse_mode: 'Markdown', ...kb.mainMenu(null) }
    );
    return ctx.reply('👇 Quick menu', kb.persistentMenu(null));
  }

  user.lastActive = new Date();
  await user.save();
  await ctx.reply(`👋 Welcome, ${user.displayName || 'Player'}!`, { ...kb.mainMenu(user) });
  return ctx.reply('👇 Quick menu', kb.persistentMenu(user));
}

async function handleRegisterButton(ctx) {
  const telegramId = String(ctx.from.id);
  const existing = await getUser(telegramId);
  if (existing) {
    await ack(ctx);
    return ctx.reply('You are already registered!', { ...kb.mainMenu(existing) });
  }
  await ack(ctx);
  await ctx.reply(
    'Please share your contact to complete registration.',
    kb.shareContactKeyboard()
  );
}

async function handleContact(ctx) {
  const telegramId = String(ctx.from.id);
  const contact = ctx.message.contact;

  if (String(contact.user_id) !== telegramId) {
    return ctx.reply('Registration requires sharing your *own* contact. Please use the Share Contact button.', {
      parse_mode: 'Markdown'
    });
  }

  let user = await getUser(telegramId);
  if (user) {
    return ctx.reply('You are already registered!', kb.removeKeyboard());
  }

  user = await User.create({
    telegramId,
    telegramUsername: ctx.from.username,
    phone: contact.phone_number,
    displayName: ctx.from.first_name || ctx.from.username || 'Player',
    isAdmin: telegramId === ADMIN_ID
  });

  await ctx.reply('✅ *Registration Successful!*', { parse_mode: 'Markdown', ...kb.removeKeyboard() });

  if (telegramId === ADMIN_ID) {
    await setState(telegramId, 'AWAITING_ADMIN_PIN');
    return ctx.reply('🔐 Admin account detected. Please enter your Admin PIN to unlock admin controls.');
  }

  await ctx.reply(`Welcome, ${user.displayName}! What would you like to do?`, { ...kb.mainMenu(user) });
  return ctx.reply('👇 Quick menu', kb.persistentMenu(user));
}

// ---------------------------------------------------------------------------
// Admin PIN (§4.2 Step 5 / §10.2)
// ---------------------------------------------------------------------------

async function handleAdminPinEntry(ctx, text) {
  const telegramId = String(ctx.from.id);

  if (await isAdminLockedOut(telegramId)) {
    return ctx.reply('🔒 Too many failed attempts. Please try again in 15 minutes.');
  }

  if (text.trim() === String(process.env.ADMIN_PIN)) {
    await recordAdminPinAttempt(telegramId, true);
    await redis.set(`admin_verified:${telegramId}`, '1', { ex: 7 * 24 * 3600 });
    await clearState(telegramId);
    const user = await getUser(telegramId);
    await ctx.reply('✅ Admin verified. Admin controls unlocked.', { ...kb.mainMenu(user) });
    return ctx.reply('👇 Quick menu', kb.persistentMenu(user));
  }

  const { locked } = await recordAdminPinAttempt(telegramId, false);
  if (locked) {
    return ctx.reply('🔒 Too many failed attempts. Locked out for 15 minutes.');
  }
  return ctx.reply('❌ Incorrect PIN. Please try again.');
}

// ---------------------------------------------------------------------------
// Play (§4.5)
// ---------------------------------------------------------------------------

async function handlePlay(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please register first.');
  await ack(ctx);
  await ctx.reply(
    `🎮 *Game Lobby*\nYour Balance: ${user.mainWalletBalance} Birr`,
    { parse_mode: 'Markdown', ...kb.playKeyboard(`${WEBAPP_URL}/game/lobby`) }
  );
}

// ---------------------------------------------------------------------------
// Balance (§5.6)
// ---------------------------------------------------------------------------

async function handleBalance(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please register first.');
  await ack(ctx);
  await ctx.reply(
    `💰 *Account Info*\nName: ${user.displayName}\nPhone: ${user.phone}\nMain Wallet: ${user.mainWalletBalance} Birr`,
    { parse_mode: 'Markdown', ...kb.walletKeyboard() }
  );
}

async function handleCopyCode(ctx) {
  const telegramId = String(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.reply(`🆔 Your ID: \`${telegramId}\``, { parse_mode: 'Markdown' });
}

// ---------------------------------------------------------------------------
// Deposit (§4.3)
// ---------------------------------------------------------------------------

async function handleDepositButton(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please register first.');
  if (user.isAdmin) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Deposits are for players only.');
    return ctx.reply('Deposits are for players only.');
  }
  await ack(ctx);
  await setState(telegramId, 'AWAITING_DEPOSIT_METHOD');
  await ctx.reply('How would you like to pay?', kb.depositMethodKeyboard());
}

async function handleDepositMethod(ctx, method) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please register first.');
  await ack(ctx);
  await setState(telegramId, 'AWAITING_DEPOSIT_AMOUNT', { method });
  await ctx.reply(`የገንዘብ መጠን ያስገቡ (min: ${DEPOSIT_MIN} Birr, max: ${DEPOSIT_MAX} Birr)`);
}

async function handleDepositAmount(ctx, text) {
  const telegramId = String(ctx.from.id);
  const state = await getState(telegramId);
  const method = (state.data && state.data.method) || 'TELEBIRR';
  const amount = Number(text.trim());
  if (!Number.isInteger(amount) || amount < DEPOSIT_MIN || amount > DEPOSIT_MAX) {
    return ctx.reply(`Please enter a whole number between ${DEPOSIT_MIN} and ${DEPOSIT_MAX} Birr (no fractions).`);
  }
  await setState(telegramId, 'AWAITING_DEPOSIT_PROOF', { amount, method });

  if (method === 'CBE') {
    await ctx.reply(
      `💰 *[${amount} ብር]* ወደ CBE አካውንት 🏦: ${CBE_ACCOUNT}${CBE_ACCOUNT_NAME ? ` (${CBE_ACCOUNT_NAME})` : ''} ይላኩ።\n` +
      `በመቀጠል በ CBE የላኩበትን ስክሪንሻት አድርገው እዚህ ላይ ይላኩ።\n\n\n`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await ctx.reply(
     `💰 *[${amount} ብር]* በቴሌብር አካውንት 📱: ${DEPOSIT_PHONE} ይላኩ።\n` +

     `በመቀጠል ከቴሌብር የደረሰወትን ማረጋገጫ ቴክስት (SMS) እዚህ ላይ ያስገቡ።\n\n\n`,
    { parse_mode: 'Markdown' }
  );
}

async function handleDepositProof(ctx, text) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  const state = await getState(telegramId);
  const amount = state.data.amount;
  const method = state.data.method || 'TELEBIRR';
  const rawProof = text.trim();

  // CBE proof is a screenshot only (handleDepositPhoto). Typed text must never
  // reach verification, so nobody can hand-write a "receipt".
  if (method === 'CBE') {
    return ctx.reply('📸 Please send a screenshot of the CBE receipt (the "Transaction Completed Successfully" screen) instead of text.');
  }

  await clearState(telegramId);
  await ctx.reply('🔄 Verifying your payment, please wait...');

  const result = await walletService.submitDeposit(user._id, amount, rawProof, method);

  if (result.duplicate) {
    return ctx.reply(
      `⚠️ This receipt has already been submitted (status: ${result.transaction.status}). ` +
        `If you believe this is an error, please contact support.`
    );
  }

  if (result.verified) {
    return ctx.reply(
      `✅ *Deposit Successful!*\n` +
        `Your wallet has been credited with ${amount} Birr.\n` +
        `💰 *New Balance:* ${result.newBalance} Birr\n` +
        `📋 *Transaction ID:* TXN-${result.transaction._id.toString().slice(-8)}`,
      { parse_mode: 'Markdown' }
    );
  }

  return ctx.reply(depositFailureMessage(result.reason, method), { parse_mode: 'Markdown' });
}

// CBE deposit proof: a screenshot of the CBE app's success screen. Register with
//   bot.on('photo', commands.handleDepositPhoto);
//   bot.on('document', commands.handleDepositPhoto);   // screenshot sent "as file"
async function handleDepositPhoto(ctx) {
  const telegramId = String(ctx.from.id);
  const state = await getState(telegramId);
  if (!state || state.action !== 'AWAITING_DEPOSIT_PROOF') return; // not mid-deposit — ignore
  const method = (state.data && state.data.method) || 'TELEBIRR';
  if (method !== 'CBE') {
    return ctx.reply('Please paste the confirmation SMS text from Telebirr (not an image).');
  }

  const msg = ctx.message;
  let fileId;
  let mediaType;
  let isDocument = false;
  if (msg.photo && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id; // largest size Telegram kept
    mediaType = 'image/jpeg';
  } else if (msg.document && ALLOWED_MEDIA_TYPES.has(msg.document.mime_type)) {
    fileId = msg.document.file_id;
    mediaType = msg.document.mime_type;
    isDocument = true;
  } else {
    return ctx.reply('Please send the receipt as an image (JPG or PNG screenshot).');
  }

  const user = await getUser(telegramId);
  const amount = state.data.amount;
  await clearState(telegramId);
  await ctx.reply('🔄 Verifying your payment, please wait...');

  // Read the screenshot. If reading fails (API down, bad image) we still submit
  // an "unreadable" proof so the deposit lands in manual review instead of vanishing.
  let rawProof;
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const res = await fetch(String(link));
    if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('screenshot larger than 5 MB');
    const fields = await readCbeReceipt(buffer, mediaType);
    rawProof = cbeVerification.serializeProof(fields, fileId);
  } catch (err) {
    logger.error('CBE screenshot read failed', { telegramId, message: err.message });
    rawProof = cbeVerification.serializeProof(null, fileId);
  }

  const result = await walletService.submitDeposit(user._id, amount, rawProof, 'CBE');

  if (result.duplicate) {
    return ctx.reply(
      `⚠️ This receipt has already been submitted (status: ${result.transaction.status}). ` +
        `If you believe this is an error, please contact support.`
    );
  }

  if (result.verified) {
    return ctx.reply(
      `✅ *Deposit Successful!*\n` +
        `Your wallet has been credited with ${amount} Birr.\n` +
        `💰 *New Balance:* ${result.newBalance} Birr\n` +
        `📋 *Transaction ID:* TXN-${result.transaction._id.toString().slice(-8)}`,
      { parse_mode: 'Markdown' }
    );
  }

  // Manual review needs the actual image, and the stored proof is only text — send it to the admin.
  if (ADMIN_ID) {
    try {
      const caption =
        `🔍 CBE screenshot needs manual review\n` +
        `User: ${user.displayName} (${user.phone})\nAmount entered: ${amount} Birr\nReason: ${result.reason || 'n/a'}`;
      if (isDocument) await ctx.telegram.sendDocument(ADMIN_ID, fileId, { caption });
      else await ctx.telegram.sendPhoto(ADMIN_ID, fileId, { caption });
    } catch (err) {
      logger.warn('Could not forward CBE screenshot to admin', { message: err.message });
    }
  }

  return ctx.reply(depositFailureMessage(result.reason, 'CBE'), { parse_mode: 'Markdown' });
}

function depositFailureMessage(reason, method = 'TELEBIRR') {
  if (method === 'CBE') return cbeDepositFailureMessage(reason);
  const providerLabel = method === 'CBE' ? 'CBE' : 'Telebirr';
  const base = {
    UNPARSEABLE:
      `❌ *We couldn't read that as a ${providerLabel} confirmation.*\n` +
      `Please paste the *entire* confirmation SMS you received from ${providerLabel}.`,
    AMOUNTMATCHES:
      `❌ *The amount in the SMS doesn't match what you entered.*\n` +
      `Please double check the amount, or wait for manual admin review.`,
    RECIPIENTNAMEMATCHES:
      `❌ *This payment doesn't appear to have been sent to our ${providerLabel} account.*\n` +
      `An admin will review this manually.`,
    RECIPIENTPHONEMATCHES:
      `❌ *This payment doesn't appear to have been sent to our ${providerLabel} account.*\n` +
      `An admin will review this manually.`,
    TRANSACTIONIDFORMATVALID:
      `❌ *That doesn't look like a valid Telebirr transaction number.*\n` +
      `Please double check you pasted the correct confirmation message.`,
    TRANSACTIONIDNOTUSED:
      `❌ *This transaction has already been used for a previous deposit.*\n` +
      `Each Telebirr confirmation can only be used once. An admin will review this manually.`,
    WITHINTIMEWINDOW:
      `⏳ *This confirmation is too old to auto-verify* (must be within 10 minutes of the transaction).\n` +
      `An admin will review this manually.`
  };
  return (
    base[reason] ||
    `❌ *Deposit Verification Failed*\n` +
      `We could not verify your payment automatically. An admin will review this request manually — ` +
      `you'll be notified once it's confirmed.`
  );
}

// Only honest-mistake failures get a specific message. Anti-forgery checks
// (isCbeReceipt, fee arithmetic, ID/date consistency) fall through to the generic
// "manual review" text so a bad actor can't learn which check tripped.
function cbeDepositFailureMessage(reason) {
  const base = {
    UNPARSEABLE:
      `❌ *We couldn't read that screenshot.*\n` +
      `Please send the *full* CBE success screen (amount, names, date/time and transaction ID all visible). ` +
      `An admin will review this manually.`,
    AMOUNTMATCHES:
      `❌ *The amount on the receipt doesn't match what you entered.*\n` +
      `Please double check the amount, or wait for manual admin review.`,
    RECIPIENTNAMEMATCHES:
      `❌ *This payment doesn't appear to have been sent to our CBE account.*\n` +
      `An admin will review this manually.`,
    RECIPIENTACCOUNTMATCHES:
      `❌ *This payment doesn't appear to have been sent to our CBE account.*\n` +
      `An admin will review this manually.`,
    RECEIPTWITHINTIMEWINDOW:
      `⏳ *This receipt is too old to auto-verify* (must be within 10 minutes of the transaction).\n` +
      `An admin will review this manually.`,
    TRANSACTIONIDNOTUSED:
      `❌ *This transaction has already been used for a previous deposit.*\n` +
      `Each CBE receipt can only be used once. An admin will review this manually.`
  };
  return (
    base[reason] ||
    `❌ *Deposit Verification Failed*\n` +
      `We could not verify your payment automatically. An admin will review this request manually — ` +
      `you'll be notified once it's confirmed.`
  );
}

// ---------------------------------------------------------------------------
// Withdrawal (§4.4)
// ---------------------------------------------------------------------------

async function handleWithdrawButton(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please register first.');
  if (user.isAdmin) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('Withdrawals are for players only.');
    return ctx.reply('Withdrawals are for players only.');
  }
  await ack(ctx);
  await setState(telegramId, 'AWAITING_WITHDRAW_AMOUNT');
  await ctx.reply(`Enter the amount you wish to withdraw (min: ${WITHDRAW_MIN} Birr, max: ${WITHDRAW_MAX} Birr)`);
}

async function handleWithdrawAmount(ctx, text) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  const amount = Number(text.trim());
  await clearState(telegramId);

  if (!Number.isInteger(amount) || amount < WITHDRAW_MIN || amount > WITHDRAW_MAX) {
    return ctx.reply(`Please enter a whole number between ${WITHDRAW_MIN} and ${WITHDRAW_MAX} Birr (no fractions).`);
  }

  try {
    const { transaction, availableBalance } = await walletService.requestWithdrawal(user._id, amount);
    await ctx.reply(
      `💸 *Withdrawal Request Received*\n` +
        `Amount: ${amount} Birr\n` +
        `*Held Balance:* ${amount} Birr\n` +
        `*Available Balance:* ${availableBalance} Birr\n` +
        `⏳ *Status:* Pending Admin Approval\n` +
        `📋 *Request ID:* WD-${transaction._id.toString().slice(-8).toUpperCase()}\n` +
        `You will be notified when your withdrawal is processed.`,
      { parse_mode: 'Markdown' }
    );
    if (ADMIN_ID) {
      await notificationService.notifyTelegram(
        ADMIN_ID,
        `🔔 New withdrawal request from ${user.displayName} (${amount} Birr). Open the Admin Panel to review.`
      );
    }
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Support / Info
// ---------------------------------------------------------------------------

async function handleSupport(ctx) {
  await ack(ctx);
  await ctx.reply('☎️ For support, contact @your_support_handle.');
}

async function handleInfo(ctx) {
  await ack(ctx);
  const botUsername = process.env.BOT_USERNAME;
  const shareLine = botUsername ? `\n\n👥 Share Bingo with friends: t.me/${botUsername}` : '';
  await ctx.reply(
    'ℹ️ *How to Play*\n' +
      '1. Deposit funds\n2. Tap Play and choose cartelas\n3. Numbers are drawn automatically every 3s\n' +
      `4. First to complete a pattern wins!${shareLine}`,
    { parse_mode: 'Markdown' }
  );
}

// ---------------------------------------------------------------------------
// Admin panel (§4.3 Admin Override, §4.4 Admin Withdrawal Management)
// ---------------------------------------------------------------------------

async function requireAdminSession(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  if (!user || !user.isAdmin) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Admins only.');
    else await ctx.reply('Admins only.');
    return null;
  }
  if (!(await isAdminVerified(telegramId))) {
    await ack(ctx);
    await setState(telegramId, 'AWAITING_ADMIN_PIN');
    await ctx.reply('🔐 Please enter your Admin PIN to continue.');
    return null;
  }
  return user;
}

async function handleAdminPanel(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ack(ctx);
  await ctx.reply('🛠️ *Admin Panel*', { parse_mode: 'Markdown', ...kb.adminPanelKeyboard() });
}

// Deposits never sit at PENDING (see walletService.submitDeposit) —
// MANUAL_REVIEW needs an APPROVE/DECLINE, APPROVED is open/reversible until
// an admin explicitly REVERSEs or FINALIZEs it (no time limit). The two
// sections are paginated independently (each with its own Prev/Next row)
// because they use different sort orders: MANUAL_REVIEW is FIFO
// oldest-first (actively waiting on a decision), APPROVED is newest-first
// (no auto-expiry, so an unbounded backlog of older already-approved
// deposits would otherwise bury freshly-approved ones under a fixed page).
async function sendDepositsReviewPage(ctx, page) {
  const total = await AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'MANUAL_REVIEW' });
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    await ctx.reply('🔍 Needs review: none.');
    return;
  }

  const needsReview = await AdminRequest.find({ type: 'DEPOSIT', status: 'MANUAL_REVIEW' })
    .populate('userId')
    .sort({ createdAt: 1 })
    .skip((page - 1) * ADMIN_PAGE_SIZE)
    .limit(ADMIN_PAGE_SIZE);

  for (const req of needsReview) {
    await ctx.reply(
      `🔍 Needs review\nDeposit: ${req.amount} Birr from ${req.userId.displayName} (${req.userId.phone})\nProof: ${req.proof}`,
      kb.depositActionKeyboard(req.status, req._id.toString())
    );
  }
  await ctx.reply(`🔍 Needs review — page ${page}/${totalPages} (${total} total)`, kb.paginationKeyboard('admin_dep_review_page', page, totalPages));
}

async function sendDepositsApprovedPage(ctx, page) {
  const total = await AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'APPROVED' });
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    await ctx.reply('✅ Auto-approved (reversible): none.');
    return;
  }

  const recentlyApproved = await AdminRequest.find({ type: 'DEPOSIT', status: 'APPROVED' })
    .populate('userId')
    .sort({ createdAt: -1 })
    .skip((page - 1) * ADMIN_PAGE_SIZE)
    .limit(ADMIN_PAGE_SIZE);

  for (const req of recentlyApproved) {
    await ctx.reply(
      `✅ Auto-approved (reversible until you Finalize it)\nDeposit: ${req.amount} Birr from ${req.userId.displayName} (${req.userId.phone})\nProof: ${req.proof}`,
      kb.depositActionKeyboard(req.status, req._id.toString())
    );
  }
  await ctx.reply(`✅ Auto-approved — page ${page}/${totalPages} (${total} total)`, kb.paginationKeyboard('admin_dep_approved_page', page, totalPages));
}

async function handleAdminDeposits(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  const [reviewCount, approvedCount] = await Promise.all([
    AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'MANUAL_REVIEW' }),
    AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'APPROVED' })
  ]);
  if (reviewCount === 0 && approvedCount === 0) {
    return ctx.reply('No deposits awaiting action.');
  }
  await sendDepositsReviewPage(ctx, 1);
  await sendDepositsApprovedPage(ctx, 1);
}

// Prev/Next taps on the "Needs review" section only re-send that section,
// so paging doesn't re-flood the chat with the (unrelated) Approved list.
async function handleAdminDepositsReviewPage(ctx, page) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  await sendDepositsReviewPage(ctx, Number(page));
}

async function handleAdminDepositsApprovedPage(ctx, page) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  await sendDepositsApprovedPage(ctx, Number(page));
}

async function sendWithdrawalsPage(ctx, page) {
  const total = await AdminRequest.countDocuments({ type: 'WITHDRAW', status: 'PENDING' });
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    await ctx.reply('No pending withdrawal requests.');
    return;
  }

  const pending = await AdminRequest.find({ type: 'WITHDRAW', status: 'PENDING' })
    .populate('userId')
    .sort({ createdAt: 1 })
    .skip((page - 1) * ADMIN_PAGE_SIZE)
    .limit(ADMIN_PAGE_SIZE);

  for (const req of pending) {
    await ctx.reply(
      `Withdrawal: ${req.amount} Birr for ${req.userId.displayName} (${req.userId.phone})`,
      kb.approveDeclineKeyboard('wd', req._id.toString())
    );
  }
  await ctx.reply(`Pending withdrawals — page ${page}/${totalPages} (${total} total)`, kb.paginationKeyboard('admin_wd_page', page, totalPages));
}

async function handleAdminWithdrawals(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  await sendWithdrawalsPage(ctx, 1);
}

async function handleAdminWithdrawalsPage(ctx, page) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  await sendWithdrawalsPage(ctx, Number(page));
}

async function handleAdminDashboard(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  const house = await HouseWallet.findOne({ walletId: 'house' });
  const [depositsNeedingReview, reversibleDeposits, pendingWithdrawals, totalUsers] = await Promise.all([
    AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'MANUAL_REVIEW' }),
    AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'APPROVED' }),
    AdminRequest.countDocuments({ type: 'WITHDRAW', status: 'PENDING' }),
    User.countDocuments({ isAdmin: false })
  ]);
  await ctx.reply(
    `📊 *Dashboard*\nHouse Wallet: ${house ? house.balance : 0} Birr\n` +
      `Deposits Needing Review: ${depositsNeedingReview}\nDeposits Reversible: ${reversibleDeposits}\n` +
      `Pending Withdrawals: ${pendingWithdrawals}\nTotal Players: ${totalUsers}`,
    { parse_mode: 'Markdown' }
  );
}

// "TRANSACTION" tab — daily/weekly/monthly/total summary of registered
// users, games played per stake, finalized deposits, manual (admin)
// credits, and approved withdrawals (see reportingService for the exact
// bucketing rules).
async function handleAdminTransactions(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();

  const summary = await reportingService.getTransactionSummary();
  const periodLabels = [
    ['daily', '📅 Daily'],
    ['weekly', '🗓️ Weekly'],
    ['monthly', '📆 Monthly'],
    ['total', '🕓 All-time']
  ];

  const lines = ['📊 *TRANSACTION SUMMARY*'];
  for (const [key, label] of periodLabels) {
    const gamesByStake = summary.gamesByStake[key];
    const gamesLine = STAKES.map((s) => `${s}: ${gamesByStake[s]}`).join(', ');
    const totalGames = STAKES.reduce((sum, s) => sum + gamesByStake[s], 0);
    const deposits = summary.deposits[key];
    const manualCredits = summary.manualCredits[key];
    const withdrawals = summary.withdrawals[key];

    lines.push(
      `\n*${label}*`,
      `👤 Registered Users: ${summary.users[key]}`,
      `🎮 Games Played (${totalGames} total) — by stake: ${gamesLine}`,
      `💵 Deposits (finalized): ${deposits.count} — ${deposits.total} Birr`,
      `🎁 Manual Credit: ${manualCredits.count} — ${manualCredits.total} Birr`,
      `💸 Withdrawals (approved): ${withdrawals.count} — ${withdrawals.total} Birr`
    );
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

// "WINNERS" tab — winner(s) of every completed game: game ID, stake, net
// prize, date/time played, and each winner's phone (+ name, when available).
// Paginated like the deposits/withdrawals lists, newest game first.

/** e.g. "Sep 12, 2026, 3:45 PM" — server-local clock, same convention used everywhere else in this file. */
function formatGameDateTime(game) {
  const when = game.endTime || game.startTime;
  if (!when) return 'unknown time';
  return new Date(when).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

async function sendWinnersPage(ctx, page) {
  const total = await Game.countDocuments({ status: 'COMPLETED' });
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    await ctx.reply('🏆 No completed games yet.');
    return;
  }

  const games = await Game.find({ status: 'COMPLETED' })
    .sort({ endTime: -1 })
    .skip((page - 1) * ADMIN_PAGE_SIZE)
    .limit(ADMIN_PAGE_SIZE);

  // Game.winners only stores ownerId (+ a displayName snapshot), not phone —
  // batch-fetch every real (non-house) winner's phone in one query rather
  // than one lookup per winner.
  const ownerIds = [...new Set(
    games.flatMap((g) => g.winners.map((w) => w.ownerId)).filter((id) => id !== 'system-admin')
  )];
  const users = ownerIds.length ? await User.find({ _id: { $in: ownerIds } }).select('phone') : [];
  const phoneById = new Map(users.map((u) => [u._id.toString(), u.phone]));

  const blocks = games.map((g) => {
    const header = `🎮 *${g.gameId}* | Stake: ${g.stake} Birr | Net Prize: ${g.noWinner ? 0 : g.prizePool} Birr | ${formatGameDateTime(g)}`;
    if (g.noWinner || g.winners.length === 0) {
      return `${header}\n   ↳ No winner — pool rolled over`;
    }
    const winnerLines = g.winners.map((w) => {
      if (w.ownerId === 'system-admin') {
        return `   🏆 House (admin cartela #${w.cartelaId})`;
      }
      const phone = phoneById.get(w.ownerId) || 'unknown';
      const name = w.displayName ? ` — ${w.displayName}` : '';
      return `   🏆 ${phone}${name} — cartela #${w.cartelaId}`;
    });
    return `${header}\n${winnerLines.join('\n')}`;
  });

  await ctx.reply(blocks.join('\n\n'), { parse_mode: 'Markdown' });
  await ctx.reply(`Page ${page}/${totalPages} (${total} completed games)`, kb.paginationKeyboard('admin_winners_page', page, totalPages));
}


async function handleAdminWinners(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  await sendWinnersPage(ctx, 1);
}

async function handleAdminWinnersPage(ctx, page) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  await sendWinnersPage(ctx, Number(page));
}

// "SIMULATOR" tab — shows the precomputed top-3 cartelas for every
// upcoming/current game. Predictions are generated and stored immediately
// when draw sequences are created, so this view never generates a new draw.
//
// Telegram's legacy Markdown parser is deliberately NOT used here. Pattern
// names such as "DIAGONAL_LINE" contain underscores and can cause Telegram
// to reject the whole message with "can't parse entities". HTML with proper
// escaping is used instead, so database values can never break Telegram's
// entity parser.
function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;');
}

async function sendSimulatorPage(ctx, page) {
  // Current games first, followed by still-unclaimed future sequences.
  const activeGames = await Game.find({
    status: { $in: ['WAITING', 'ACTIVE', 'SETTLING'] },
    drawSequenceId: { $ne: null }
  }, { gameId: 1, stake: 1, status: 1, drawSequenceId: 1 }).lean();

  const activeBySequence = new Map(
    activeGames.map((game) => [String(game.drawSequenceId), game])
  );

  const activeSequenceIds = activeGames.map((game) => game.drawSequenceId);
  const upcomingSequences = await DrawSequence.find({
    $or: [
      { used: false },
      ...(activeSequenceIds.length ? [{ _id: { $in: activeSequenceIds } }] : [])
    ]
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const total = upcomingSequences.length;
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);

  if (total === 0) {
    await ctx.reply('<b>🎯 SIMULATOR</b>\nNo upcoming draw sequences are currently available.', { parse_mode: 'HTML' });
    return;
  }

  const pageItems = upcomingSequences.slice(
    (page - 1) * ADMIN_PAGE_SIZE,
    page * ADMIN_PAGE_SIZE
  );

  const lines = [
    '<b>🎯 SIMULATOR — PRECOMPUTED WINNERS</b>',
    `Showing <b>${pageItems.length}</b> of <b>${total}</b> upcoming/current sequence(s).`,
    'The list is generated from the stored 75-number draw order and the 200 cartela master set.',
    ''
  ];

  pageItems.forEach((sequence, index) => {
    const game = activeBySequence.get(String(sequence._id));
    const position = (page - 1) * ADMIN_PAGE_SIZE + index + 1;
    const status = game
      ? `GAME ${game.gameId} · ${game.stake} Birr · ${game.status}`
      : 'UPCOMING · not yet claimed';

    lines.push(`<b>${position}. ${escapeTelegramHtml(status)}</b>`);
    lines.push(`Sequence: <code>${escapeTelegramHtml(String(sequence._id).slice(-8))}</code>`);

    const winners = (sequence.predictedWinners || []).slice(0, 3);
    if (winners.length === 0) {
      lines.push('⚠️ No top-3 prediction is stored for this sequence.');
    } else {
      winners.forEach((winner) => {
        const patterns = Array.isArray(winner.patterns) && winner.patterns.length
          ? winner.patterns.join(', ')
          : 'UNKNOWN_PATTERN';
        lines.push(
          `${escapeTelegramHtml(winner.rank)}. Cartela <b>#${escapeTelegramHtml(winner.cartelaId)}</b>` +
          ` — draw <b>#${escapeTelegramHtml(winner.drawIndex)}</b>` +
          ` (${escapeTelegramHtml(winner.drawNumber)})` +
          ` — <code>${escapeTelegramHtml(patterns)}</code>`
        );
      });
    }

    lines.push('');
  });

  lines.push(`Page <b>${page}/${totalPages}</b>`);

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...kb.paginationKeyboard('admin_simulator_page', page, totalPages)
  });
}

async function handleAdminSimulator(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  try {
    // Backfill any old sequences that predate this feature before displaying.
    await simulatorService.ensurePredictionsForExistingSequences();
    await sendSimulatorPage(ctx, 1);
  } catch (err) {
    logger.error('Simulator admin view failed', { error: err.message, stack: err.stack });
    await ctx.reply(`⚠️ Simulator unavailable: ${err.message}`);
  }
}

async function handleAdminSimulatorPage(ctx, page) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  try {
    await simulatorService.ensurePredictionsForExistingSequences();
    await sendSimulatorPage(ctx, Number(page));
  } catch (err) {
    logger.error('Simulator admin page failed', { error: err.message, stack: err.stack });
    await ctx.reply(`⚠️ Simulator unavailable: ${err.message}`);
  }
}

async function handleDepositDecision(ctx, action, id) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  try {
    if (action === 'approve') {
      const { newBalance } = await walletService.approveDeposit(id, admin._id);
      await ctx.reply('✅ Deposit approved.');
      const req = await AdminRequest.findById(id);
      const user = await User.findById(req.userId);
      await notificationService.notifyTelegram(
        user.telegramId,
        `✅ *Deposit Successful!*\nYour wallet has been credited.\n💰 *New Balance:* ${newBalance} Birr`
      );
    } else if (action === 'reverse') {
      const { adminRequest, newBalance, penaltyAmount } = await walletService.reverseDeposit(id, admin._id);
      await ctx.reply(`⚠️ Deposit reversed. 40% penalty applied: ${penaltyAmount} Birr.`);
      const user = await User.findById(adminRequest.userId);
      await notificationService.notifyTelegram(
        user.telegramId,
        `❌ *Deposit Reversed*\nA 40% penalty (${penaltyAmount} Birr) has been applied.\n💰 *New Balance:* ${newBalance} Birr`
      );
    } else if (action === 'finalize') {
      await walletService.finalizeDeposit(id, admin._id);
      await ctx.reply('✅ Deposit finalized — no longer reversible.');
    } else {
      const { adminRequest } = await walletService.declineDeposit(id, admin._id, 'Manual review declined');
      await ctx.reply('❌ Deposit declined.');
      const user = await User.findById(adminRequest.userId);
      await notificationService.notifyTelegram(user.telegramId, `❌ *Deposit Declined*\nReason: Manual review declined`);
    }
  } catch (err) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
}

async function handleWithdrawDecision(ctx, action, id) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  try {
    if (action === 'approve') {
      const { adminRequest } = await walletService.approveWithdrawal(id, admin._id);
      const user = await User.findById(adminRequest.userId);
      await ctx.reply('✅ Withdrawal approved.');
      await notificationService.notifyTelegram(
        user.telegramId,
        `✅ *Withdrawal Approved!*\nYour withdrawal of ${adminRequest.amount} Birr has been processed.\n` +
          `The funds have been sent to your registered account.\n📋 *Request ID:* WD-${adminRequest._id.toString().slice(-8).toUpperCase()}`
      );
    } else {
      const { adminRequest, newBalance } = await walletService.declineWithdrawal(id, admin._id, 'Declined by admin');
      const user = await User.findById(adminRequest.userId);
      await ctx.reply('❌ Withdrawal declined.');
      await notificationService.notifyTelegram(
        user.telegramId,
        `❌ *Withdrawal Declined*\nReason: ${adminRequest.declineReason}\n` +
          `The held funds (${adminRequest.amount} Birr) have been returned to your available balance.\n` +
          `💰 *Available Balance:* ${newBalance} Birr`
      );
    }
  } catch (err) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
}

async function handleAdminCreditButton(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  await setState(String(ctx.from.id), 'AWAITING_ADMIN_CREDIT_TARGET');
  await ctx.reply('Enter the Telegram ID or phone number of the user to credit:');
}

async function handleAdminCreditTarget(ctx, text) {
  const target = text.trim();
  const user = await User.findOne({ $or: [{ telegramId: target }, { phone: target }] });
  if (!user) return ctx.reply('User not found. Please enter a valid Telegram ID or phone number.');
  await setState(String(ctx.from.id), 'AWAITING_ADMIN_CREDIT_AMOUNT', { targetUserId: user._id.toString() });
  await ctx.reply(`Enter the amount to credit ${user.displayName}:`);
}

async function handleAdminCreditAmount(ctx, text) {
  const telegramId = String(ctx.from.id);
  const admin = await getUser(telegramId);
  const state = await getState(telegramId);
  const amount = Number(text.trim());
  await clearState(telegramId);

  if (!Number.isInteger(amount) || amount <= 0) return ctx.reply('Invalid amount — enter a whole number of Birr (no fractions).');

  try {
    const { newBalance } = await walletService.adminCredit(state.data.targetUserId, amount, admin._id, 'Manual admin credit');
    const target = await User.findById(state.data.targetUserId);
    await ctx.reply(`✅ Credited ${amount} Birr to ${target.displayName}. New balance: ${newBalance} Birr.`);
    await notificationService.notifyTelegram(
      target.telegramId,
      `💰 Your wallet has been credited with ${amount} Birr by an admin.\nNew balance: ${newBalance} Birr`
    );
  } catch (err) {
    await ctx.reply(`⚠️ ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Free-text router — dispatches based on the user's UserState.action
// ---------------------------------------------------------------------------

// Persistent reply-keyboard labels (see keyboards.js persistentMenu) mapped
// to their existing handlers. Checked before conversation state so tapping a
// menu button always works immediately, even mid-flow (e.g. mid-deposit).
const MENU_TEXT_HANDLERS = {
  '📝 Register': handleRegisterButton,
  '🎮 Play': handlePlay,
  '💰 Balance': handleBalance,
  '💵 Deposit': handleDepositButton,
  '💸 Withdraw': handleWithdrawButton,
  '☎️ Support': handleSupport,
  'ℹ️ Info': handleInfo,
  '🛠️ Admin Panel': handleAdminPanel
};

async function routeTextMessage(ctx) {
  const telegramId = String(ctx.from.id);
  const text = ctx.message.text;

  const menuHandler = MENU_TEXT_HANDLERS[text];
  if (menuHandler) {
    await clearState(telegramId); // tapping a menu button cancels any in-progress flow (e.g. mid-deposit)
    return menuHandler(ctx);
  }

  const state = await getState(telegramId);
  if (!state || !state.action) return; // no active conversation — ignore

  switch (state.action) {
    case 'AWAITING_ADMIN_PIN':
      return handleAdminPinEntry(ctx, text);
    case 'AWAITING_DEPOSIT_AMOUNT':
      return handleDepositAmount(ctx, text);
    case 'AWAITING_DEPOSIT_PROOF':
      return handleDepositProof(ctx, text);
    case 'AWAITING_WITHDRAW_AMOUNT':
      return handleWithdrawAmount(ctx, text);
    case 'AWAITING_ADMIN_CREDIT_TARGET':
      return handleAdminCreditTarget(ctx, text);
    case 'AWAITING_ADMIN_CREDIT_AMOUNT':
      return handleAdminCreditAmount(ctx, text);
    default:
      return;
  }
}

module.exports = {
  handleStart,
  handleRegisterButton,
  handleContact,
  handlePlay,
  handleBalance,
  handleCopyCode,
  handleDepositButton,
  handleDepositMethod,
  handleDepositPhoto,
  handleWithdrawButton,
  handleSupport,
  handleInfo,
  handleAdminPanel,
  handleAdminDeposits,
  handleAdminDepositsReviewPage,
  handleAdminDepositsApprovedPage,
  handleAdminWithdrawals,
  handleAdminWithdrawalsPage,
  handleAdminDashboard,
  handleAdminTransactions,
  handleAdminWinners,
  handleAdminWinnersPage,
  handleAdminSimulator,
  handleAdminSimulatorPage,
  handleDepositDecision,
  handleWithdrawDecision,
  handleAdminCreditButton,
  routeTextMessage
};
