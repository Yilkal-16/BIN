const mongoose = require('mongoose');
const { Schema } = mongoose;

// Singleton document (walletId is always 'house'). Balance is a cached
// derivative of the house-attributed rows in Transaction, kept in sync
// atomically alongside every write that touches it (§7.1/§7.2).
const houseWalletSchema = new Schema({
  walletId: { type: String, required: true, default: 'house', unique: true },
  balance: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

houseWalletSchema.pre('save', function preSave(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.HouseWallet || mongoose.model('HouseWallet', houseWalletSchema);
