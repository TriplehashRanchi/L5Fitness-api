/**
 * Loads and validates environment variables.
 *
 * Local files are read in this order (first value wins, real process env always wins):
 *   .env.local  →  .env
 * `neon deploy` / `neon env pull` writes the Neon values into whichever of those exists.
 * In production set the same names in your host's environment instead of shipping a file.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
for (const file of ['.env.local', '.env']) {
  const full = path.join(root, file);
  if (fs.existsSync(full)) process.loadEnvFile(full);
}

const missing = [];

function required(name) {
  const value = process.env[name]?.trim();
  // "<your-auth-base-url>" style placeholders count as not set.
  if (!value || /^<.*>$/.test(value)) {
    missing.push(name);
    return '';
  }
  return value;
}

const port = Number(process.env.PORT) || 4000;

const env = {
  port,

  // The gym's own time zone. Class times in the timetable are in this zone.
  gymTimeZone: process.env.GYM_TIME_ZONE?.trim() || 'Asia/Kolkata',
  // Set to 1 when the API runs behind one proxy/load balancer (most hosts), so the real
  // client address is used for login rate limits. Leave unset when running directly.
  trustProxy: Number(process.env.TRUST_PROXY) || 0,

  // Postgres. App traffic uses the pooled URL (PgBouncer); migrations use the direct one.
  databaseUrlDirect: process.env.DATABASE_URL_UNPOOLED?.trim() || required('DATABASE_URL'),
  databaseUrlPooled: process.env.DATABASE_URL_POOLED?.trim() || required('DATABASE_URL'),

  // The one admin. The person who signs in with this VERIFIED email becomes the admin, but only while
  // there is no admin yet. Leave it empty to set the admin by hand: npm run role -- <email> admin
  adminEmail: process.env.ADMIN_EMAIL?.trim().toLowerCase() || '',

  // Firebase Authentication. Only the project ID is needed to check a member's token.
  firebaseProjectId: required('FIREBASE_PROJECT_ID'),

  // Object storage (S3-compatible). The AWS SDK also reads the AWS_* names by itself.
  s3Endpoint: required('AWS_ENDPOINT_URL_S3'),
  s3AccessKeyId: required('AWS_ACCESS_KEY_ID'),
  s3SecretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
  s3Region: required('AWS_REGION'),
  s3Bucket: required('S3_BUCKET'),
};

if (missing.length) {
  const names = [...new Set(missing)].join(', ');
  throw new Error(
    `Missing environment variables: ${names}. Run \`neon env pull\` or fill them in .env.local.`
  );
}

module.exports = env;
