const mongoose = require('mongoose');
const { Schema } = mongoose;

const userStateSchema = new Schema({
  userId: { type: String, required: true, unique: true }, // telegramId
  action: String, // e.g. 'AWAITING_DEPOSIT_AMOUNT', 'AWAITING_DEPOSIT_PROOF', ...
  data: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

userStateSchema.index({ userId: 1 }, { unique: true });
userStateSchema.index({ updatedAt: 1 });

userStateSchema.pre('findOneAndUpdate', function preUpdate(next) {
  this.set({ updatedAt: new Date() });
  next();
});

module.exports = mongoose.models.UserState || mongoose.model('UserState', userStateSchema);
