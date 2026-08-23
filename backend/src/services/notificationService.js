const logger = require('../utils/logger');

let botInstance = null;
let ioInstance = null;

function init({ bot, io }) {
  botInstance = bot;
  ioInstance = io;
}

/** Sends a Markdown-formatted Telegram message to a user by their telegramId. */
async function notifyTelegram(telegramId, text) {
  if (!botInstance) return;
  try {
    await botInstance.telegram.sendMessage(telegramId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.warn('Failed to send Telegram notification', { telegramId, error: err.message });
  }
}

/** Broadcasts a Socket.IO event to every client that joined a given game room. */
function emitToGame(gameId, event, payload) {
  if (!ioInstance) return;
  ioInstance.to(`game:${gameId}`).emit(event, payload);
}

/** Sends a Socket.IO event to a single user's private room (if connected). */
function emitToUser(userId, event, payload) {
  if (!ioInstance) return;
  ioInstance.to(`user:${userId}`).emit(event, payload);
}

module.exports = { init, notifyTelegram, emitToGame, emitToUser };
