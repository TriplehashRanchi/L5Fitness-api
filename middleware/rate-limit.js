/**
 * A ceiling per network address, far above normal use, to stop runaway clients.
 * Password guessing and sign-up spam are limited by Firebase itself, not here.
 *
 * Counts are kept in this process's memory, which is right for one server. If the API ever runs
 * as several copies, move the counts to a shared store (e.g. Redis) or each copy counts alone.
 */
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const tooMany = (req, res) =>
  res.status(429).json({
    error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Wait a few minutes and try again.' },
  });

// Per person: keyed on the sign-in token, so a whole gym on one wifi (one shared address) does not share one budget.
const crypto = require('node:crypto');
const tokenKey = (req) => {
  const header = req.get('authorization');
  return header ? `t:${crypto.createHash('sha256').update(header).digest('hex').slice(0, 24)}` : `ip:${ipKeyGenerator(req.ip)}`;
};
const userLimiter = rateLimit({
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  windowMs: 60_000,
  limit: 600,
  keyGenerator: tokenKey,
  handler: tooMany,
});

// Per network address, much higher: stops one machine from spraying random tokens or paths.
const ipLimiter = rateLimit({
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  windowMs: 60_000,
  limit: 3000,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip)}`,
  handler: tooMany,
});

const apiLimiter = [ipLimiter, userLimiter];

/**
 * Guessing the admin password: 10 WRONG tries per 15 minutes for one email from one address.
 * Successful sign-ins are not counted. Keyed on the email as well, so one person trying random
 * addresses cannot lock the real admin out, and the real admin's address stays protected.
 */
const adminLoginLimiter = rateLimit({
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    return `${ipKeyGenerator(req.ip)}|${email}`;
  },
  handler: (req, res) =>
    res.status(429).json({
      error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong attempts. Wait 15 minutes and try again.' },
    }),
});

module.exports = { apiLimiter, adminLoginLimiter };
