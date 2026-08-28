const mongoose = require('mongoose');

/**
 * Distributed lock for the game engine (§12 addendum).
 *
 * Render's zero-downtime deploys boot the new instance *alongside* the
 * still-running old one, and only send SIGTERM to the old instance ~60s
 * after cutover (https://render.com/docs/zero-downtime-deploys). Without
 * this lock, both processes independently call engine.start() during that
 * window and race to drive the same in-flight game document, which surfaces
 * as "State transition precondition failed (concurrent writer?)" errors and
 * can leave duplicate games running for the same stake tier.
 *
 * This is a single lease-based lock document: whoever holds a non-expired
 * lease is the only process allowed to run the stake loops. The holder
 * renews its lease periodically; if renewal ever fails (lost the race, or
 * this process stalled long enough for the lease to expire), the caller
 * must stop its loops immediately.
 */

const LOCK_ID = 'game-engine';
const LEASE_MS = 20_000; // how long a lease is valid once acquired/renewed
const RENEW_MS = 8_000; // renew well before the lease expires
const ACQUIRE_RETRY_MS = 3_000; // how often a waiting instance retries acquisition

const engineLockSchema = new mongoose.Schema(
  {
    _id: { type: String, default: LOCK_ID },
    holder: String,
    expiresAt: Date
  },
  { collection: 'engine_locks' }
);

// Guard against OverwriteModelError on hot-reload (nodemon, tests, etc.)
const EngineLock = mongoose.models.EngineLock || mongoose.model('EngineLock', engineLockSchema);

/**
 * Attempts to acquire (or take over an expired) lock for `holderId`.
 * Returns true if this call made `holderId` the current holder.
 */
async function tryAcquire(holderId) {
  const now = new Date();
  try {
    const result = await EngineLock.findOneAndUpdate(
      { _id: LOCK_ID, $or: [{ expiresAt: null }, { expiresAt: { $lt: now } }] },
      { $set: { holder: holderId, expiresAt: new Date(now.getTime() + LEASE_MS) } },
      { upsert: true, new: true }
    );
    return !!result && result.holder === holderId;
  } catch (err) {
    // Duplicate-key error means another process already holds a live lease
    // (its document didn't match our filter, so the upsert tried — and
    // failed — to insert a second doc with the same _id). That's a normal,
    // expected "someone else has it" outcome, not a real failure.
    if (err && err.code === 11000) return false;
    throw err;
  }
}

/** Renews `holderId`'s lease. Returns false if it no longer holds the lock. */
async function renew(holderId) {
  const now = new Date();
  const result = await EngineLock.findOneAndUpdate(
    { _id: LOCK_ID, holder: holderId },
    { $set: { expiresAt: new Date(now.getTime() + LEASE_MS) } },
    { new: true }
  );
  return !!result;
}

/** Best-effort release so the next instance doesn't have to wait out the full lease on graceful shutdown. */
async function release(holderId) {
  await EngineLock.deleteOne({ _id: LOCK_ID, holder: holderId });
}

module.exports = { tryAcquire, renew, release, LEASE_MS, RENEW_MS, ACQUIRE_RETRY_MS };
