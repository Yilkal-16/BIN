const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Single-document store (_id: 'house') for settings the admin changes live
 * from the Telegram Admin Panel — currently the house auto-allocation switch
 * and its cartela amount. Kept in MongoDB (not env vars) so a change takes
 * effect on the very next round without a redeploy, and survives restarts.
 */
const houseSettingsSchema = new Schema({
  _id: { type: String, default: 'house' },
  // Master switch. OFF by default: nothing is auto-allocated until an admin turns it ON.
  autoAllocateEnabled: { type: Boolean, default: false },
  // AMOUNT_ADMIN_CARTELAS. null = never set in the panel (env default applies).
  amountAdminCartelas: { type: Number, default: null },
  // ADMIN-WIN-INTERVAL: every Nth auto-allocated game the house buys the simulator's
  // rank-1 cartela. 0 = off. null = never set in the panel (env default applies).
  // (Field keeps its original name so values already saved stay valid.)
  predictedWinnerEveryGames: { type: Number, default: null },
  updatedBy: { type: String, default: null }, // admin telegramId
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.HouseSettings || mongoose.model('HouseSettings', houseSettingsSchema);
