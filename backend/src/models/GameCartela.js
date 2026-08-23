const mongoose = require('mongoose');
const { Schema } = mongoose;

// SCOPED PER GAME (§9.4). gameId is the canonical external string ("BG...."),
// deliberately NOT an ObjectId ref — every external identifier stays external
// end-to-end (§8.1) and this is the collection most often queried by gameId
// alongside REST/WS payloads, so no string<->ObjectId translation is needed.
const gameCartelaSchema = new Schema({
  gameId: { type: String, required: true, index: true },
  cartelaId: { type: Number, required: true },
  // null = available. Set to a User._id (string) or 'system-admin' once claimed.
  // Pre-seeded as null (or 'system-admin' for globally-reserved cartelas) the
  // moment a game is created — see cartelaService.createGameCartelaPool —
  // so the atomic findOneAndUpdate allocation pattern in §6.4/§10.4 always
  // has an existing document to match against.
  ownerId: { type: String, default: null },
  isWinner: { type: Boolean, default: false },
  matchedNumbers: { type: [Number], default: [] },
  isReserved: { type: Boolean, default: false },
  purchasedAt: { type: Date, default: null }
});

gameCartelaSchema.index({ gameId: 1, cartelaId: 1 }, { unique: true });
gameCartelaSchema.index({ ownerId: 1, gameId: 1 });
gameCartelaSchema.index({ gameId: 1, isWinner: 1 });

module.exports = mongoose.models.GameCartela || mongoose.model('GameCartela', gameCartelaSchema);
