const { User } = require('../models');

/**
 * User-scoped events (as opposed to game-room-scoped ones in
 * gameHandlers.js). Currently just a balance snapshot on demand — winnings
 * and deposit confirmations are pushed proactively via
 * notificationService.emitToUser from the services that create them.
 */
function registerUserHandlers(io, socket) {
  socket.on('request_balance', async (_payload, ack) => {
    const user = await User.findById(socket.userId).select('mainWalletBalance coins');
    const balance = user ? { mainWallet: user.mainWalletBalance, coins: user.coins } : null;
    if (typeof ack === 'function') ack(balance);
    else socket.emit('balance_update', balance);
  });
}

module.exports = registerUserHandlers;
