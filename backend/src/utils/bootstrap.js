const { User, HouseWallet } = require('../models');
const logger = require('./logger');

const HOUSE_TELEGRAM_ID = 'SYSTEM_HOUSE';

/**
 * Ensures the sentinel "house" User document exists (see the note in
 * models/Transaction.js for why this exists) and returns its _id.
 */
async function ensureHouseUser() {
  let houseUser = await User.findOne({ telegramId: HOUSE_TELEGRAM_ID });
  if (!houseUser) {
    houseUser = await User.create({
      telegramId: HOUSE_TELEGRAM_ID,
      phone: 'house-internal', // unique, never a real dialable number
      displayName: 'House',
      isAdmin: true,
      mainWalletBalance: 0
    });
    logger.info('Created sentinel house User document', { userId: houseUser._id.toString() });
  }
  return houseUser;
}

/**
 * Ensures the House Wallet singleton exists, seeding it with
 * HOUSE_WALLET_INITIAL_BALANCE the first time only (§6.5, §15.3 Step 1).
 */
async function ensureHouseWallet() {
  let wallet = await HouseWallet.findOne({ walletId: 'house' });
  if (!wallet) {
    const initial = Number(process.env.HOUSE_WALLET_INITIAL_BALANCE || 0);
    wallet = await HouseWallet.create({ walletId: 'house', balance: initial });
    logger.info('Initialized House Wallet', { balance: initial });
  }
  return wallet;
}

async function ensureAdminUser() {
  const adminId = process.env.ADMIN_ID;
  if (!adminId) {
    logger.warn('ADMIN_ID not set — admin bot commands will be unavailable');
    return null;
  }
  let admin = await User.findOne({ telegramId: String(adminId) });
  if (!admin) {
    admin = await User.create({
      telegramId: String(adminId),
      phone: `admin-${adminId}`,
      displayName: 'Admin',
      isAdmin: true,
      mainWalletBalance: 0
    });
    logger.info('Created admin User record', { telegramId: adminId });
  } else if (!admin.isAdmin) {
    admin.isAdmin = true;
    await admin.save();
  }
  return admin;
}

async function runStartupBootstrap() {
  await ensureHouseUser();
  await ensureHouseWallet();
  await ensureAdminUser();
}

module.exports = { HOUSE_TELEGRAM_ID, ensureHouseUser, ensureHouseWallet, ensureAdminUser, runStartupBootstrap };
