/**
 * Slows down password guessing and sign-up spam.
 *
 * Counts are kept in this process's memory, which is right for one server. If the API ever runs
 * as several copies, move the counts to a shared store (e.g. Redis) or each copy counts alone.
 */
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const tooMany = (req, res) =>
  res.status(429).json({
    error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Wait a few minutes and try again.' },
  });

const base = { standardHeaders: 'draft-8', legacyHeaders: false, handler: tooMany };

/**
 * 10 failed tries per 15 minutes for one email from one network address. Keyed on both so that many
 * members on the gym Wi-Fi (one shared address) do not lock each other out.
 */
const loginLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60_000,
  limit: 10,
  skipSuccessfulRequests: true, // only failed tries count; logging in normally is never limited
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    return `${ipKeyGenerator(req.ip)}|${email}`;
  },
});

/** 20 new accounts per hour from one network address. */
const registerLimiter = rateLimit({ ...base, windowMs: 60 * 60_000, limit: 20 });

/** A ceiling on everything else, per address: far above normal use, stops runaway clients. */
const apiLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 300 });

module.exports = { loginLimiter, registerLimiter, apiLimiter };
