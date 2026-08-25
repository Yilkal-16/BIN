// backend/src/controllers/depositController.js
const walletService = require('../services/walletService');
const { verifyDeposit } = require('../services/verificationEngine');
const logger = require('../utils/logger');

class DepositController {
    /**
     * Submit deposit for verification (Bot endpoint)
     */
    async submitDeposit(req, res) {
        try {
            const { userId, amount, smsText, botSessionId } = req.body;

            // Validate required fields
            if (!userId || !amount || !smsText) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields: userId, amount, smsText'
                });
            }

            if (isNaN(amount) || amount <= 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid amount. Must be a positive number'
                });
            }

            // Process deposit
            const result = await walletService.processDepositViaSMS({
                userId,
                amount: parseFloat(amount),
                smsText,
                botSessionId: botSessionId || 'unknown'
            });

            // Prepare response
            const response = {
                success: true,
                data: {
                    depositId: result.transaction._id,
                    status: result.transaction.status,
                    message: result.verificationResult.status === 'APPROVED'
                        ? 'Deposit approved'
                        : 'Deposit requires manual review'
                }
            };

            // Add receipt number if available
            if (result.transaction.receiptNumber) {
                response.data.receiptNumber = result.transaction.receiptNumber;
            }

            // Add reason if manual review
            if (result.verificationResult.reason) {
                response.data.reason = result.verificationResult.reason;
            }

            return res.status(200).json(response);

        } catch (error) {
            logger.error('Error in submitDeposit:', error);
            return res.status(500).json({
                success: false,
                error: 'Internal server error while processing deposit'
            });
        }
    }

    /**
     * Get deposit by ID (Admin)
     */
    async getDeposit(req, res) {
        try {
            const { id } = req.params;
            const deposit = await walletService.getDepositById(id);

            if (!deposit) {
                return res.status(404).json({
                    success: false,
                    error: 'Deposit not found'
                });
            }

            return res.status(200).json({
                success: true,
                data: deposit
            });
        } catch (error) {
            logger.error('Error in getDeposit:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch deposit'
            });
        }
    }

    /**
     * Get all deposits with filters (Admin)
     */
    async getDeposits(req, res) {
        try {
            const filters = req.query;
            const result = await walletService.getDeposits(filters);

            return res.status(200).json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('Error in getDeposits:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch deposits'
            });
        }
    }

    /**
     * Admin approve deposit (only for MANUAL_REVIEW)
     */
    async approveDeposit(req, res) {
        try {
            const { id } = req.params;
            const { adminNotes } = req.body;

            const deposit = await walletService.adminApproveDeposit(
                id,
                adminNotes || 'Approved by admin'
            );

            return res.status(200).json({
                success: true,
                data: deposit,
                message: 'Deposit approved successfully'
            });
        } catch (error) {
            logger.error('Error in approveDeposit:', error);
            return res.status(400).json({
                success: false,
                error: error.message || 'Failed to approve deposit'
            });
        }
    }

    /**
     * Admin reverse deposit with 40% penalty (only for APPROVED)
     */
    async reverseDeposit(req, res) {
        try {
            const { id } = req.params;
            const { adminNotes } = req.body;

            if (!adminNotes) {
                return res.status(400).json({
                    success: false,
                    error: 'Admin notes required for reversal'
                });
            }

            const deposit = await walletService.adminReverseDeposit(id, adminNotes);

            return res.status(200).json({
                success: true,
                data: deposit,
                message: `Deposit reversed with 40% penalty`
            });
        } catch (error) {
            logger.error('Error in reverseDeposit:', error);
            return res.status(400).json({
                success: false,
                error: error.message || 'Failed to reverse deposit'
            });
        }
    }

    /**
     * Get deposit statistics (Admin)
     */
    async getDepositStats(req, res) {
        try {
            const stats = await walletService.getDepositStats();

            return res.status(200).json({
                success: true,
                data: stats
            });
        } catch (error) {
            logger.error('Error in getDepositStats:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch statistics'
            });
        }
    }

    /**
     * Verify SMS only (testing endpoint)
     */
    async verifySmsOnly(req, res) {
        try {
            const { smsText, amount } = req.body;

            if (!smsText) {
                return res.status(400).json({
                    success: false,
                    error: 'smsText required'
                });
            }

            const result = await verifyDeposit({
                amount: amount || 0,
                rawProof: smsText
            });

            return res.status(200).json({
                success: true,
                data: result
            });
        } catch (error) {
            logger.error('Error in verifySmsOnly:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to verify SMS'
            });
        }
    }
}

module.exports = new DepositController();