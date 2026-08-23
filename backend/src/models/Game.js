const mongoose = require('mongoose');
const { Schema } = mongoose;

const winnerSchema = new Schema(
  {
    ownerId: { type: String, required: true }, // userId (Mongo _id as string) OR 'system-admin'
    cartelaId: { type: Number, required: true },
    prizeAmount: { type: Number, required: true },
    pattern: { type: [String], default: [] } // matched patterns, for display only
  },
  { _id: false }
);

const gameSchema = new Schema({
  gameId: { type: String, required: true, unique: true }, // e.g. "BG240701001"
  stake: { type: Number, required: true, default: 10 }, // Single tier for v1 (§4.5)
  drawSequenceId: { type: Schema.Types.ObjectId, ref: 'DrawSequence' },
  status: {
    type: String,
    enum: ['WAITING', 'ACTIVE', 'SETTLING', 'COMPLETED'],
    default: 'WAITING',
    index: true
  },
  currentDrawIndex: { type: Number, default: 0 },
  startTime: Date,
  endTime: Date,
  prizePool: Number, // Net Prize Pool once known
  grossPrizePool: Number,
  houseCommission: Number,
  winners: { type: [winnerSchema], default: [] },
  noWinner: { type: Boolean, default: false }, // all 75 drawn, nobody won (§12)
  rolloverFromGameId: { type: String, default: null },
  // Optimistic-locking guard for state transitions (§10.4).
  version: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

gameSchema.index({ status: 1, startTime: -1 });
gameSchema.index({ gameId: 1 }, { unique: true });

gameSchema.pre('save', function preSave(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.models.Game || mongoose.model('Game', gameSchema);
