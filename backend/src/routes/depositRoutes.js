// backend/src/routes/depositRoutes.js
const express = require('express');
const router = express.Router();
const depositController = require('../controllers/depositController');
const { authenticateBot, authenticateAdmin } = require('../middleware/auth');

// Bot endpoints
router.post('/verify', authenticateBot, depositController.submitDeposit);
router.post('/verify-sms', authenticateBot, depositController.verifySmsOnly);

// Admin endpoints
router.get('/admin/deposits', authenticateAdmin, depositController.getDeposits);
router.get('/admin/deposits/:id', authenticateAdmin, depositController.getDeposit);
router.post('/admin/deposits/:id/approve', authenticateAdmin, depositController.approveDeposit);
router.post('/admin/deposits/:id/reverse', authenticateAdmin, depositController.reverseDeposit);
router.get('/admin/statistics', authenticateAdmin, depositController.getDepositStats);

module.exports = router;