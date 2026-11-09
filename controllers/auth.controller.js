const auth = require('../services/neon-auth');
const { HttpError } = require('../middleware/errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function readEmail(body) {
  const email = text(body?.email).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254)
    throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  return email;
}

async function register(req, res) {
  const name = text(req.body?.name);
  if (name.length < 2 || name.length > 80)
    throw new HttpError(400, 'INVALID_NAME', 'Enter your full name.');
  const email = readEmail(req.body);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)
    throw new HttpError(400, 'INVALID_PASSWORD', `Use a password of at least ${MIN_PASSWORD} characters.`);

  res.status(201).json(await auth.signUp({ name, email, password }));
}

async function login(req, res) {
  const email = readEmail(req.body);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || password.length > MAX_PASSWORD)
    throw new HttpError(400, 'INVALID_PASSWORD', 'Enter your password.');

  res.json(await auth.signIn({ email, password }));
}

function me(req, res) {
  res.json({ user: req.user });
}

async function logout(req, res) {
  await auth.signOut(req.token);
  res.status(204).end();
}

module.exports = { register, login, me, logout };
