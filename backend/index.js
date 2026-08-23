require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');

const logger = require('./src/utils/logger');
const { connectDatabase } = require('./src/utils/database');
const { runStartupBootstrap } = require('./src/utils/bootstrap');
const { notFoundHandler, errorHandler } = require('./src/middleware/errorHandler');
const { initSocketServer } = require('./src/sockets');
const { createBot } = require('./src/bot/webhook');
const notificationService = require('./src/services/notificationService');
const walletService = require('./src/services/walletService');
const engine = require('./src/game/engine');
const { Cartela } = require('./src/models');

const REQUIRED_ENV = ['MONGODB_URI', 'REDIS_URL', 'REDIS_TOKEN', 'BOT_TOKEN', 'JWT_SECRET', 'ADMIN_ID', 'ADMIN_PIN'];

function checkRequiredEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    process.exit(1);
  }
}

async function main() {
  checkRequiredEnv();

  await connectDatabase();
  await runStartupBootstrap();

  const cartelaCount = await Cartela.countDocuments({});
  if (cartelaCount === 0) {
    logger.error(
      '########################################################################\n' +
      '# NO CARTELA TEMPLATES FOUND. The game engine cannot create a playable #\n' +
      '# round without them, and the selection screen will show every cartela #\n' +
      '# as unavailable. Run this once against THIS environment\'s database:  #\n' +
      '#                                                                      #\n' +
      '#     npm run import:cartelas                                         #\n' +
      '#                                                                      #\n' +
      '# The engine will keep retrying every 30s and will pick this up       #\n' +
      '# automatically as soon as the import finishes — no restart needed.   #\n' +
      '########################################################################'
    );
  }

  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

  const bot = createBot();

  // Telegram webhook endpoint. In production, set this via scripts/setWebhook.js.
  app.use(bot.webhookCallback('/api/webhook'));
  // JSON body parsing for everything EXCEPT the webhook route above, which
  // Telegraf's own middleware already parses.
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  app.use('/api/auth', require('./src/api/auth'));
  app.use('/api/user', require('./src/api/user'));
  app.use('/api/wallet', require('./src/api/wallet'));
  app.use('/api/game', require('./src/api/game'));
  app.use('/api/cartela', require('./src/api/cartela'));
  app.use('/api/admin', require('./src/api/admin'));

  app.use(notFoundHandler);
  app.use(errorHandler);

  const httpServer = http.createServer(app);
  const io = initSocketServer(httpServer);

  notificationService.init({ bot, io });

  const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    logger.info(`Backend listening on port ${PORT}`);
  });

  // Periodic maintenance: auto-release withdrawals stuck past the hold
  // timeout (§4.4/§12). Runs independently of the game loop.
  setInterval(() => {
    walletService.autoReleaseStaleWithdrawals().catch((err) => {
      logger.error('autoReleaseStaleWithdrawals failed', { error: err.message });
    });
  }, 15 * 60 * 1000);

  // The continuous game engine (§0.4/§6.3) — runs forever, recovering from
  // crashes on this call itself since recoverOnBoot() is the first thing it does.
  engine.start().catch((err) => {
    logger.error('Game engine crashed unexpectedly', { error: err.message, stack: err.stack });
    process.exit(1);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received — shutting down gracefully`);
    engine.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
