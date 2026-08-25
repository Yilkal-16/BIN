const mongoose = require('mongoose');
const { Schema } = mongoose;

const adminRequestSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['DEPOSIT', 'WITHDRAW'], required: true },
  amount: { type: Number, required: true },
  proof: String, // For deposits
  // MANUAL_REVIEW / REVERSED / FINALIZED are deposit-only states (SMS
  // auto-verification workflow): PENDING -> APPROVED (auto or manual) or
  // MANUAL_REVIEW -> APPROVED -> (REVERSED | FINALIZED). FINALIZED means
  // an admin confirmed it genuine (or the review window expired
  // unreversed) — it's a closed, no-longer-actionable state, distinct from
  // APPROVED which is still within its reversal window. WITHDRAW keeps
  // using PENDING/APPROVED/DECLINED.
  status: { type: String, enum: ['PENDING', 'APPROVED', 'DECLINED', 'MANUAL_REVIEW', 'REVERSED', 'FINALIZED'], default: 'PENDING', index: true },
  adminId: { type: Schema.Types.ObjectId, ref: 'User' },
  adminNotes: String,
  declineReason: String,
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  // Withdrawal-specific fields (§9.6)
  heldAmount: Number, // Amount placed on hold during withdrawal
  releaseDate: Date, // When funds were returned (if declined / auto-released)
  payoutConfirmed: Boolean // Admin confirms offline payout processed
});

adminRequestSchema.index({ status: 1, createdAt: 1 });
adminRequestSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.models.AdminRequest || mongoose.model('AdminRequest', adminRequestSchema);
