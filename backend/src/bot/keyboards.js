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
    [Markup.button.callback('Dashboard Stats', 'admin_dashboard')]
  ]);
}

function approveDeclineKeyboard(type, id) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', `${type}_approve_${id}`),
      Markup.button.callback('❌ Decline', `${type}_decline_${id}`)
    ]
  ]);
}

module.exports = {
  mainMenu,
  shareContactKeyboard,
  removeKeyboard,
  playKeyboard,
  walletKeyboard,
  adminPanelKeyboard,
  approveDeclineKeyboard
};
