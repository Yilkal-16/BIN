const mongoose = require('mongoose');
const { Schema } = mongoose;

// Transaction is the immutable, append-only ledger (§7.2): wallet balances
// are a cached derivative of this collection, never the other way around.
//
// Schema note on `userId`: the PRD types this as an ObjectId ref('User')
// "required: true" but also says it holds the literal 'house' for
// house-attributed rows (§9.5). Those two statements can't both be true for
// a Mongoose ObjectId field, so — per the brief's own instruction to resolve
// internal inconsistencies with the smallest faithful change — house-side
// transactions reference a real, seeded sentinel User document (telegramId
// 'SYSTEM_HOUSE') instead of the unstorable string 'house'. This keeps
// `userId` an honest ObjectId ref everywhere, and the actual running house
// balance still lives in the dedicated HouseWallet singleton (§9.9), exactly
// as specified — this sentinel user only exists to give house rows a valid
// ledger subject. See utils/houseUser.js.
const transactionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: [
      'DEPOSIT',
      'WITHDRAW',
      'GAME_PURCHASE',
      'WINNING',
      'ADMIN_CREDIT',
      'ADMIN_AUTO_PURCHASE', // House buys cartelas
      'HOUSE_COMMISSION', // 20% house cut
      'HOUSE_FRACTIONAL', // Fractional ETB remainder
      'HOUSE_WINNING', // Admin cartela wins
      'ROLLOVER' // No-winner round rolls prize pool to next game
    ],
    required: true
  },
  amount: { type: Number, required: true },
  description: String,
  receiptNumber: { type: String, unique: true, sparse: true }, // Telebirr reference (dedup key)
  referenceId: { type: String, unique: true, sparse: true }, // Internal: "TXN-20260705-000001"
  gameId: { type: String }, // Reference to game if applicable
  cartelaIds: { type: [Number], default: undefined }, // Cartelas involved (for game purchases)
  metadata: { type: Schema.Types.Mixed },
  // APPROVED / MANUAL_REVIEW / REVERSED are DEPOSIT-only states (SMS
  // auto-verification workflow, see walletService.submitDeposit): other
  // transaction types (WITHDRAW, GAME_PURCHASE, WINNING, etc.) still only
  // ever use PENDING/COMPLETED/FAILED.
  status: {
    type: String,
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'APPROVED', 'MANUAL_REVIEW', 'REVERSED'],
    default: 'PENDING'
  },
  timestamp: { type: Date, default: Date.now }
});

transactionSchema.index({ userId: 1, timestamp: -1 });
transactionSchema.index({ receiptNumber: 1 }, { unique: true, sparse: true });
transactionSchema.index({ referenceId: 1 }, { unique: true, sparse: true });
transactionSchema.index({ userId: 1, type: 1, gameId: 1 }); // idempotent game purchases

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema);
