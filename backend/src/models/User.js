const mongoose = require('mongoose');
const { Schema } = mongoose;

// NOTE: coins / referralCode / referredBy are part of the schema per the PRD
// (§9.1) but are Phase 2 features (§18) — no logic reads or writes them yet
// beyond the default values below. Keeping the fields now avoids a schema
// migration later.
const userSchema = new Schema({
  telegramId: { type: String, required: true, unique: true },
  telegramUsername: String,
  phone: { type: String, required: true, unique: true },
  displayName: String,
  walletAddress: String,
  mainWalletBalance: { type: Number, default: 0 },
  coins: { type: Number, default: 0 }, // Phase 2 - Out of Scope for v1
  isAdmin: { type: Boolean, default: false },
  referralCode: { type: String, unique: true, sparse: true }, // Phase 2
  referredBy: { type: Schema.Types.ObjectId, ref: 'User' }, // Phase 2
  totalGamesPlayed: { type: Number, default: 0 },
  totalWins: { type: Number, default: 0 },
  totalWinnings: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now }
});

userSchema.index({ telegramId: 1 }, { unique: true });
userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ referralCode: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
