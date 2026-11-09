const db = require('../services/db');
const storage = require('../services/storage');
const auth = require('../services/firebase-auth');

async function check(run) {
  const started = Date.now();
  try {
    await run();
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    console.error('[health]', err.message);
    return { ok: false, ms: Date.now() - started };
  }
}

/** Reports whether each Neon service answers. 200 when all do, 503 otherwise. */
async function health(req, res) {
  const [postgres, objectStorage, neonAuth] = await Promise.all([
    check(() => db.ping()),
    check(() => storage.ping()),
    check(() => auth.ping()),
  ]);
  const services = { postgres, storage: objectStorage, auth: neonAuth };
  const ok = Object.values(services).every((s) => s.ok);
  res.status(ok ? 200 : 503).json({ ok, services });
}

module.exports = { health };
