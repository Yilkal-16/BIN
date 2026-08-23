const logger = require('../utils/logger');
const { fail } = require('../utils/helpers');

/** Thrown by services to carry an HTTP status + error code up to the API layer. */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFoundHandler(req, res) {
  return fail(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return fail(res, err.status, err.code, err.message, err.details);
  }
  if (err && err.name === 'ValidationError') {
    return fail(res, 400, 'INVALID_AMOUNT', err.message);
  }
  logger.error('Unhandled API error', { error: err.message, stack: err.stack });
  return fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
}

module.exports = { ApiError, notFoundHandler, errorHandler };
