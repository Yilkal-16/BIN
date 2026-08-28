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

const ACQUIRE_RETRIES = 5;
const RETRY_DELAY_MS = 25;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Atomically returns the next value for `name` (e.g. 'referenceId:20260827').
 *
 * findByIdAndUpdate + upsert is normally race-free per MongoDB's own
 * document-level atomicity guarantee, EXCEPT for one documented edge case:
 * when the target document doesn't exist yet (i.e. the very first call for
 * a brand-new key, such as the first reference of a new day) and two
 * callers race to create it, one can receive an E11000 duplicate-key error
 * on the counter's own _id instead of a valid incremented value —
 * https://github.com/Automattic/mongoose/issues/7183 and
 * https://www.mongodb.com/community/forums/t/what-is-the-correct-way-to-do-an-upsert/294181
 * both show this happening even though the operation is otherwise atomic.
 * A short retry loop is the standard, documented mitigation: the loser
 * simply retries once the winner's document exists, at which point the
 * same call becomes a normal (non-upsert) atomic increment.
 *
 * `session` is optional — pass it to make this increment part of the same
 * Mongo transaction as whatever document(s) it's generating an ID for, so a
 * transaction abort/retry can't advance the sequence without the write it
 * was for actually committing.
 */
async function getNextSequence(name, session) {
  for (let attempt = 0; attempt < ACQUIRE_RETRIES; attempt++) {
    try {
      const doc = await Counter.findByIdAndUpdate(
        name,
        { $inc: { seq: 1 } },
        { new: true, upsert: true, session }
      );
      return doc.seq;
    } catch (err) {
      const isLastAttempt = attempt === ACQUIRE_RETRIES - 1;
      if (err.code === 11000 && !isLastAttempt) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop always returns or throws — but keeps the
  // function's return type honest for linters.
  throw new Error(`getNextSequence('${name}') exhausted retries`);
}

module.exports = { Counter, getNextSequence };
