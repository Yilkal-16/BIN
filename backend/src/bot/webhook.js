const { Telegraf } = require('telegraf');
const commands = require('./commands');
const logger = require('../utils/logger');

function createBot() {
  const bot = new Telegraf(process.env.BOT_TOKEN);

  bot.start(commands.handleStart);
  bot.action('register', commands.handleRegisterButton);
  bot.on('contact', commands.handleContact);

  bot.action('play', commands.handlePlay);
  bot.action('balance', commands.handleBalance);
  bot.action('copy_code', commands.handleCopyCode);
  bot.action('deposit', commands.handleDepositButton);
  bot.action('withdraw', commands.handleWithdrawButton);
  bot.action('support', commands.handleSupport);
  bot.action('info', commands.handleInfo);

  bot.action('admin_panel', commands.handleAdminPanel);
  bot.action('admin_deposits', commands.handleAdminDeposits);
  bot.action('admin_withdrawals', commands.handleAdminWithdrawals);
  bot.action('admin_dashboard', commands.handleAdminDashboard);
  bot.action('admin_credit', commands.handleAdminCreditButton);

  bot.action(/^dep_approve_(.+)$/, (ctx) => commands.handleDepositDecision(ctx, 'approve', ctx.match[1]));
  bot.action(/^dep_decline_(.+)$/, (ctx) => commands.handleDepositDecision(ctx, 'decline', ctx.match[1]));
  bot.action(/^dep_reverse_(.+)$/, (ctx) => commands.handleDepositDecision(ctx, 'reverse', ctx.match[1]));
  bot.action(/^dep_finalize_(.+)$/, (ctx) => commands.handleDepositDecision(ctx, 'finalize', ctx.match[1]));
  bot.action(/^wd_approve_(.+)$/, (ctx) => commands.handleWithdrawDecision(ctx, 'approve', ctx.match[1]));
  bot.action(/^wd_decline_(.+)$/, (ctx) => commands.handleWithdrawDecision(ctx, 'decline', ctx.match[1]));

  bot.on('text', commands.routeTextMessage);

  bot.catch((err, ctx) => {
    logger.error('Telegraf error', { error: err.message, stack: err.stack, updateType: ctx.updateType });
  });

  return bot;
}

module.exports = { createBot };
