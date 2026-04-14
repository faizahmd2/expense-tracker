'use strict';

/**
 * middleware/errorHandler.js
 * Central error handler — logs to console, returns clean JSON.
 */

function errorHandler(err, req, res, next) {
  const status = err.status ?? err.statusCode ?? 500;

  console.error(`[error] ${req.method} ${req.path} →`, err.message);
  if (status === 500) console.error(err.stack);

  res.status(status).json({
    error:   err.message ?? 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = { errorHandler };
