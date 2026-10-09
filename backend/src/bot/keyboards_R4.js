const { Markup } = require('telegraf');

function mainMenu(user) {
  const rows = [];
  if (!user) {
    rows.push([Markup.button.callback('Register 📝', 'register')]);
    return Markup.inlineKeyboard(rows);
  }
  if (!user.isAdmin) {
    rows.push([Markup.button.callback('Play 🎮', 'play')]);
    rows.push([Markup.button.callback('Balance 💰', 'balance'), Markup.button.callback('Deposit 💵', 'deposit')]);
    rows.push([Markup.button.callback('Withdraw 💸', 'withdraw')]);
    rows.push([Markup.button.callback('Support ☎️', 'support'), Markup.button.callback('Info ℹ️', 'info')]);
  } else {
    rows.push([Markup.button.callback('Admin Panel 🛠️', 'admin_panel')]);
    rows.push([Markup.button.callback('Balance 💰', 'balance')]);
  }
  return Markup.inlineKeyboard(rows);
}

/**
 * Persistent quick-access menu — a reply keyboard (not inline), so it stays
 * docked at the bottom of the chat across every message instead of being
 * attached to one specific bubble. Lets players jump to Play/Balance/Deposit
 * etc. without scrolling back to find the original inline menu.
 */
function persistentMenu(user) {
  if (!user) {
    return Markup.keyboard([['📝 Register']]).resize();
  }
  if (user.isAdmin) {
    return Markup.keyboard([['🛠️ Admin Panel', '💰 Balance']]).resize();
  }
  return Markup.keyboard([
    ['🎮 Play', '💰 Balance'],
    ['💵 Deposit', '💸 Withdraw'],
    ['☎️ Support', 'ℹ️ Info']
  ]).resize();
}

function shareContactKeyboard() {
  return Markup.keyboard([Markup.button.contactRequest('Share Contact 📱')])
    .oneTime()
    .resize();
}

function removeKeyboard() {
  return Markup.removeKeyboard();
}

function playKeyboard(webAppUrl) {
  return Markup.inlineKeyboard([[Markup.button.webApp('Play Now', webAppUrl)]]);
}

/** Payment-method choice shown right when a player starts a deposit (§4.3). */
function depositMethodKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 Telebirr', 'deposit_method_TELEBIRR'),
      Markup.button.callback('🏦 CBE', 'deposit_method_CBE')
    ]
  ]);
}

function walletKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Deposit 💵', 'deposit'), Markup.button.callback('Withdraw 💸', 'withdraw')],
    [Markup.button.callback('Copy Code 📋', 'copy_code')]
  ]);
}

function adminPanelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Pending Deposits', 'admin_deposits')],
    [Markup.button.callback('Pending Withdrawals', 'admin_withdrawals')],
    [Markup.button.callback('Manual Credit', 'admin_credit')],
    [Markup.button.callback('Dashboard Stats', 'admin_dashboard')],
    [Markup.button.callback('📊 TRANSACTION', 'admin_transactions')],
    [Markup.button.callback('🏆 WINNERS', 'admin_winners')],
    [Markup.button.callback('🎯 SIMULATOR', 'admin_simulator')]
  ]);
}

/**
 * Prev/Next row for a paginated admin list. `prefix` is the callback-data
 * prefix this list's page buttons are registered under in webhook.js (e.g.
 * 'admin_wd_page'); tapping a button sends `${prefix}_<page>`. Omits a
 * direction's button rather than disabling it, since Telegram inline
 * buttons can't be disabled.
 */
function paginationKeyboard(prefix, page, totalPages) {
  const row = [];
  if (page > 1) row.push(Markup.button.callback('◀️ Prev', `${prefix}_${page - 1}`));
  if (page < totalPages) row.push(Markup.button.callback('Next ▶️', `${prefix}_${page + 1}`));
  return Markup.inlineKeyboard(row.length ? [row] : []);
}

function approveDeclineKeyboard(type, id) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', `${type}_approve_${id}`),
      Markup.button.callback('❌ Decline', `${type}_decline_${id}`)
    ]
  ]);
}

/**
 * Deposit action keyboard — deposits no longer follow the simple
 * PENDING -> approve/decline shape approveDeclineKeyboard was built for
 * (see walletService.submitDeposit): a deposit sitting in MANUAL_REVIEW
 * needs an APPROVE button, one that's already APPROVED (auto or manual)
 * needs a REVERSE (+40%) button for the post-hoc double-check, and
 * REVERSED is a terminal state with no action left.
 */
function depositActionKeyboard(status, id) {
  if (status === 'MANUAL_REVIEW') {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Approve', `dep_approve_${id}`),
        Markup.button.callback('❌ Decline', `dep_decline_${id}`)
      ]
    ]);
  }
  if (status === 'APPROVED') {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('⚠️ Reverse (+40%)', `dep_reverse_${id}`),
        Markup.button.callback('✅ Finalize', `dep_finalize_${id}`)
      ]
    ]);
  }
  // REVERSED / FINALIZED (or anything unexpected) — nothing left to do.
  return Markup.inlineKeyboard([]);
}

module.exports = {
  mainMenu,
  persistentMenu,
  shareContactKeyboard,
  removeKeyboard,
  playKeyboard,
  depositMethodKeyboard,
  walletKeyboard,
  adminPanelKeyboard,
  paginationKeyboard,
  approveDeclineKeyboard,
  depositActionKeyboard
};
