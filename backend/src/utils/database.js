const mongoose = require('mongoose');
const logger = require('./logger');

let connecting = null;

/**
 * Connects to MongoDB Atlas. Safe to call multiple times (returns the
 * existing connection promise if a connection attempt is already underway).
 */
function connectDatabase() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  if (connecting) return connecting;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  mongoose.set('strictQuery', true);

  connecting = mongoose
    .connect(uri, {
      dbName: process.env.MONGODB_DB_NAME || 'BINGCL',
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 10000
    })
    .then((conn) => {
      logger.info('MongoDB connected', { db: conn.connection.name });
      return conn;
    })
    .catch((err) => {
      connecting = null;
      logger.error('MongoDB connection failed, retrying in 5s', { error: err.message });
      return new Promise((resolve, reject) => {
        setTimeout(() => connectDatabase().then(resolve).catch(reject), 5000);
      });
    });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — mongoose will attempt to reconnect automatically');
  });

  return connecting;
}

module.exports = { connectDatabase, mongoose };
