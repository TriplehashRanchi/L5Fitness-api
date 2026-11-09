/**
 * A ceiling per network address, far above normal use, to stop runaway clients.
 * Password guessing and sign-up spam are limited by Firebase itself, not here.
 *
 * Counts are kept in this process's memory, which is right for one server. If the API ever runs
 * as several copies, move the counts to a shared store (e.g. Redis) or each copy counts alone.
 */
const { rateLimit } = require('express-rate-limit');

const apiLimiter = rateLimit({
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  windowMs: 60_000,
  limit: 300,
  handler: (req, res) =>
    res.status(429).json({
      error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Wait a few minutes and try again.' },
    }),
});

module.exports = { apiLimiter };
