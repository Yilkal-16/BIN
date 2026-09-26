const mongoose = require('mongoose');
const { Schema } = mongoose;

const predictedWinnerSchema = new Schema(
  {
    rank: { type: Number, required: true },
    cartelaId: { type: Number, required: true },
    drawIndex: { type: Number, required: true },
    drawNumber: { type: Number, required: true },
    patterns: { type: [String], default: [] }
  },
  { _id: false }
);

const drawSequenceSchema = new Schema({
  numbers: { type: [Number], required: true }, // 1-75 in random order
  used: { type: Boolean, default: false },
  usedAt: Date,
  gameId: { type: String, default: null }, // Canonical gameId (external), set once consumed
  // Server-side prediction generated immediately from the same stored draw
  // sequence and the 200 immutable Cartela templates. Admin-only data.
  predictedWinners: { type: [predictedWinnerSchema], default: [] },
  predictionVersion: { type: Number, default: 1 },
  predictedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

drawSequenceSchema.index({ used: 1, createdAt: 1 });

module.exports = mongoose.models.DrawSequence || mongoose.model('DrawSequence', drawSequenceSchema);
