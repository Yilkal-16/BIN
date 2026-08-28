const mongoose = require('mongoose');
const { Schema } = mongoose;

// Small addition beyond the PRD's explicit model list: the ID formats in
// §8.1 (BG240701001, TXN-20260705-000001) require *some* atomic sequence
// source. A single-document atomic counter via findOneAndUpdate($inc) is the
// simplest production-safe way to generate that sequence without races,
// so it's included here rather than inventing an in-memory counter that
// would collide across restarts or (later) multiple instances.
const counterSchema = new Schema({
  _id: { type: String, required: true }, // e.g. 'gameId:20260705', 'referenceId:20260705'
  seq: { type: Number, default: 0 }
});

const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

async function getNextSequence(name) {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
}

module.exports = { Counter, getNextSequence };
