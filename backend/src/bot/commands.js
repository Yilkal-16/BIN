const { User, UserState, AdminRequest, Transaction, HouseWallet } = require('../models');
const walletService = require('../services/walletService');
const notificationService = require('../services/notificationService');
const { redis, recordAdminPinAttempt, isAdminLockedOut } = require('../utils/redis');
const logger = require('../utils/logger');
const kb = require('./keyboards');

const WEBAPP_URL = process.env.WEBAPP_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const DEPOSIT_PHONE = process.env.DEPOSIT_PHONE_NUMBER || '0968200522';
const DEPOSIT_MIN = Number(process.env.DEPOSIT_MIN_AMOUNT || 10);
const DEPOSIT_MAX = Number(process.env.DEPOSIT_MAX_AMOUNT || 50000);
const WITHDRAW_MIN = Number(process.env.WITHDRAW_MIN_AMOUNT || 50);
const WITHDRAW_MAX = Number(process.env.WITHDRAW_MAX_AMOUNT || 15000);
const VERIFY_TIMEOUT_MS = Number(process.env.TELEBIRR_VERIFICATION_TIMEOUT || 120) * 1000;

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

// ---------------------------------------------------------------------------
// Registration (§4.2)
// ---------------------------------------------------------------------------

async function handleStart(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);

  if (!user) {
    return ctx.reply(
      '👋 *Welcome to Bingo!*\nPlay 75-ball Bingo right inside Telegram.',
      { parse_mode: 'Markdown', ...kb.mainMenu(null) }
    );
  }

  user.lastActive = new Date();
  await user.save();
  return ctx.reply(`👋 Welcome back, ${user.displayName || 'Player'}!`, { ...kb.mainMenu(user) });
}

async function handleRegisterButton(ctx) {
  const telegramId = String(ctx.from.id);
  const existing = await getUser(telegramId);
  if (existing) {
    await ctx.answerCbQuery();
    return ctx.reply('You are already registered!', { ...kb.mainMenu(existing) });
  }
  await ctx.answerCbQuery();
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

  return ctx.reply(`Welcome, ${user.displayName}! What would you like to do?`, { ...kb.mainMenu(user) });
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
    return ctx.reply('✅ Admin verified. Admin controls unlocked.', { ...kb.mainMenu(user) });
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
  await ctx.answerCbQuery();
  await ctx.reply(
    `🎮 *Game Lobby*\nCurrent Stake: 10 Birr\nYour Balance: ${user.mainWalletBalance} Birr`,
    { parse_mode: 'Markdown', ...kb.playKeyboard(`${WEBAPP_URL}/game/cartela-selection`) }
  );
}

// ---------------------------------------------------------------------------
// Balance (§5.6)
// ---------------------------------------------------------------------------

async function handleBalance(ctx) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  if (!user) return ctx.reply('Please register first.');
  await ctx.answerCbQuery();
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
  if (user.isAdmin) return ctx.answerCbQuery('Deposits are for players only.');
  await ctx.answerCbQuery();
  await setState(telegramId, 'AWAITING_DEPOSIT_AMOUNT');
  await ctx.reply(`Enter the amount you wish to deposit (min: ${DEPOSIT_MIN} Birr, max: ${DEPOSIT_MAX} Birr)`);
}

async function handleDepositAmount(ctx, text) {
  const telegramId = String(ctx.from.id);
  const amount = Number(text.trim());
  if (!Number.isFinite(amount) || amount < DEPOSIT_MIN || amount > DEPOSIT_MAX) {
    return ctx.reply(`Please enter a valid amount between ${DEPOSIT_MIN} and ${DEPOSIT_MAX} Birr.`);
  }
  await setState(telegramId, 'AWAITING_DEPOSIT_PROOF', { amount });
  await ctx.reply(
    `💰 *Deposit Instructions*\n` +
      `Please send ${amount} Birr to the following Telebirr account:\n` +
      `📱 *Telebirr Number:* ${DEPOSIT_PHONE}\n` +
      `---\n` +
      `*After payment, copy the ENTIRE confirmation SMS from Telebirr and paste it here* — the whole message, not just the link or the transaction number.\n\n` +
      `_(If you no longer have the full message, pasting just the receipt link or the transaction number still works.)_\n` +
      `---\n` +
      `⚠️ *Important:* Do not close this chat until your deposit is confirmed.\n` +
      `⏳ *Verification timeout:* ${VERIFY_TIMEOUT_MS / 1000 / 60} minutes`,
    { parse_mode: 'Markdown' }
  );
}

async function handleDepositProof(ctx, text) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  const state = await getState(telegramId);
  const amount = state.data.amount;
  const rawProof = text.trim();

  await clearState(telegramId);
  await ctx.reply('🔄 Verifying your payment, please wait...');

  const result = await walletService.submitDeposit(user._id, amount, rawProof);

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

  return ctx.reply(depositFailureMessage(result.reason), { parse_mode: 'Markdown' });
}

function depositFailureMessage(reason) {
  const base = {
    UNPARSEABLE:
      `❌ *We couldn't read that as a Telebirr confirmation.*\n` +
      `Please paste the *entire* confirmation SMS you received from Telebirr, or at minimum the receipt link or transaction number.`,
    FETCH_FAILED:
      `⏳ *We couldn't reach the Telebirr receipt page just now* to confirm your payment automatically.\n` +
      `Your request has been sent for manual admin review — you'll be notified once it's confirmed.`,
    TRANSACTION_ID_NOT_FOUND:
      `❌ *The receipt page didn't match the transaction you sent us.*\n` +
      `Please double check you pasted the correct confirmation message. An admin will also review this manually.`,
    AMOUNT_MISMATCH:
      `❌ *The amount on the Telebirr receipt doesn't match what you entered.*\n` +
      `Please double check the amount and try again, or wait for manual admin review.`,
    RECIPIENT_MISMATCH:
      `❌ *This payment doesn't appear to have been sent to our Telebirr account.*\n` +
      `Please double check the number you sent to. An admin will also review this manually.`
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
  if (user.isAdmin) return ctx.answerCbQuery('Withdrawals are for players only.');
  await ctx.answerCbQuery();
  await setState(telegramId, 'AWAITING_WITHDRAW_AMOUNT');
  await ctx.reply(`Enter the amount you wish to withdraw (min: ${WITHDRAW_MIN} Birr, max: ${WITHDRAW_MAX} Birr)`);
}

async function handleWithdrawAmount(ctx, text) {
  const telegramId = String(ctx.from.id);
  const user = await getUser(telegramId);
  const amount = Number(text.trim());
  await clearState(telegramId);

  if (!Number.isFinite(amount) || amount < WITHDRAW_MIN || amount > WITHDRAW_MAX) {
    return ctx.reply(`Please enter a valid amount between ${WITHDRAW_MIN} and ${WITHDRAW_MAX} Birr.`);
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
  await ctx.answerCbQuery();
  await ctx.reply('☎️ For support, contact @your_support_handle.');
}

async function handleInfo(ctx) {
  await ctx.answerCbQuery();
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
    await ctx.answerCbQuery('Admins only.');
    return null;
  }
  if (!(await isAdminVerified(telegramId))) {
    await ctx.answerCbQuery();
    await setState(telegramId, 'AWAITING_ADMIN_PIN');
    await ctx.reply('🔐 Please enter your Admin PIN to continue.');
    return null;
  }
  return user;
}

async function handleAdminPanel(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  await ctx.reply('🛠️ *Admin Panel*', { parse_mode: 'Markdown', ...kb.adminPanelKeyboard() });
}

async function handleAdminDeposits(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  const pending = await AdminRequest.find({ type: 'DEPOSIT', status: 'PENDING' }).populate('userId').limit(10);
  if (pending.length === 0) return ctx.reply('No pending deposit requests.');
  for (const req of pending) {
    await ctx.reply(
      `Deposit: ${req.amount} Birr from ${req.userId.displayName} (${req.userId.phone})\nProof: ${req.proof}`,
      kb.approveDeclineKeyboard('dep', req._id.toString())
    );
  }
}

async function handleAdminWithdrawals(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  const pending = await AdminRequest.find({ type: 'WITHDRAW', status: 'PENDING' }).populate('userId').limit(10);
  if (pending.length === 0) return ctx.reply('No pending withdrawal requests.');
  for (const req of pending) {
    await ctx.reply(
      `Withdrawal: ${req.amount} Birr for ${req.userId.displayName} (${req.userId.phone})`,
      kb.approveDeclineKeyboard('wd', req._id.toString())
    );
  }
}

async function handleAdminDashboard(ctx) {
  const admin = await requireAdminSession(ctx);
  if (!admin) return;
  await ctx.answerCbQuery();
  const house = await HouseWallet.findOne({ walletId: 'house' });
  const [pendingDeposits, pendingWithdrawals, totalUsers] = await Promise.all([
    AdminRequest.countDocuments({ type: 'DEPOSIT', status: 'PENDING' }),
    AdminRequest.countDocuments({ type: 'WITHDRAW', status: 'PENDING' }),
    User.countDocuments({ isAdmin: false })
  ]);
  await ctx.reply(
    `📊 *Dashboard*\nHouse Wallet: ${house ? house.balance : 0} Birr\n` +
      `Pending Deposits: ${pendingDeposits}\nPending Withdrawals: ${pendingWithdrawals}\nTotal Players: ${totalUsers}`,
    { parse_mode: 'Markdown' }
  );
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
    } else {
      await walletService.declineDeposit(id, admin._id, 'Manual review declined');
      await ctx.reply('❌ Deposit declined.');
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

  if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Invalid amount.');

  const { newBalance } = await walletService.adminCredit(state.data.targetUserId, amount, admin._id, 'Manual admin credit');
  const target = await User.findById(state.data.targetUserId);
  await ctx.reply(`✅ Credited ${amount} Birr to ${target.displayName}. New balance: ${newBalance} Birr.`);
  await notificationService.notifyTelegram(
    target.telegramId,
    `💰 Your wallet has been credited with ${amount} Birr by an admin.\nNew balance: ${newBalance} Birr`
  );
}

// ---------------------------------------------------------------------------
// Free-text router — dispatches based on the user's UserState.action
// ---------------------------------------------------------------------------

async function routeTextMessage(ctx) {
  const telegramId = String(ctx.from.id);
  const text = ctx.message.text;
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
  handleWithdrawButton,
  handleSupport,
  handleInfo,
  handleAdminPanel,
  handleAdminDeposits,
  handleAdminWithdrawals,
  handleAdminDashboard,
  handleDepositDecision,
  handleWithdrawDecision,
  handleAdminCreditButton,
  routeTextMessage
};
