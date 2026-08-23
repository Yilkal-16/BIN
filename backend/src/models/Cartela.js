const mongoose = require('mongoose');
const { Schema } = mongoose;

// GLOBAL TEMPLATE — no ownership fields here (§9.2). Ownership only ever
// exists via GameCartela records scoped to a specific gameId (§6.1/§6.4).
const cartelaSchema = new Schema({
  cartelaId: { type: Number, required: true, unique: true }, // 1-600
  grid: { type: [[Number]], required: true }, // 5x5 array (null for FREE space)
  isReserved: { type: Boolean, default: false } // Admin pre-reserved (global, e.g. IDs 1-50)
});

cartelaSchema.index({ cartelaId: 1 }, { unique: true });

module.exports = mongoose.models.Cartela || mongoose.model('Cartela', cartelaSchema);
