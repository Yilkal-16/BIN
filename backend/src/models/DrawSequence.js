const mongoose = require('mongoose');
const { Schema } = mongoose;

const drawSequenceSchema = new Schema({
  numbers: { type: [Number], required: true }, // 1-75 in random order
  used: { type: Boolean, default: false },
  usedAt: Date,
  gameId: { type: String, default: null }, // Canonical gameId (external), set once consumed
  createdAt: { type: Date, default: Date.now }
});

drawSequenceSchema.index({ used: 1, createdAt: 1 });

module.exports = mongoose.models.DrawSequence || mongoose.model('DrawSequence', drawSequenceSchema);
