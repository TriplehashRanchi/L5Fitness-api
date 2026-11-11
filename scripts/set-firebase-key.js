/**
 * Adds the two lines the API needs to send browser alerts, from a Firebase service-account key file:
 *
 *   npm run firebase:key -- /path/to/level5fitness-firebase-adminsdk-xxxx.json
 *
 * It reads the file here on your computer and writes FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY into
 * .env. The key is never printed. Afterwards delete the downloaded file (or keep it somewhere safe), and
 * never commit .env.
 */
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run firebase:key -- /path/to/service-account.json');
  process.exit(1);
}
let key;
try {
  key = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read that file as JSON: ${err.message}`);
  process.exit(1);
}
if (key.type !== 'service_account' || !key.client_email || !key.private_key) {
  console.error('That does not look like a Firebase service-account key (it needs client_email and private_key).');
  process.exit(1);
}

const envFile = path.join(__dirname, '..', '.env');
let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const project = /^FIREBASE_PROJECT_ID=(.*)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (project && key.project_id !== project) {
  console.error(`This key belongs to the Firebase project "${key.project_id}", but this API uses "${project}". Download the key from the right project.`);
  process.exit(1);
}

const set = (name, value) => {
  const line = `${name}="${value}"`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\s*$/, '\n')}${line}\n`;
};
set('FIREBASE_CLIENT_EMAIL', key.client_email);
set('FIREBASE_PRIVATE_KEY', key.private_key.replace(/\n/g, '\\n'));
fs.writeFileSync(envFile, text, { mode: 0o600 });
console.log(`Saved FIREBASE_CLIENT_EMAIL (${key.client_email}) and FIREBASE_PRIVATE_KEY to .env.`);
console.log('Restart the API to use them.');
