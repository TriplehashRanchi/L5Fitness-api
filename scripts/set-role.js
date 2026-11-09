/**
 * Sets someone's role by hand.
 *   npm run role -- someone@example.com dietitian     (or member, or admin)
 *   npm run role -- --list
 * The person must have opened the app or the console once, so that they exist here.
 * There can be only one admin: making a second one is refused.
 */
const db = require('../services/db');
const members = require('../models/member.model');

(async () => {
  const [a, b] = process.argv.slice(2);
  if (a === '--list') {
    const { rows } = await db.query("select name, email, role, disabled from members where role <> 'member' order by role, email");
    console.log(rows.length ? rows.map((r) => `${r.role.padEnd(10)} ${r.email}  (${r.name})${r.disabled ? '  [disabled]' : ''}`).join('\n') : 'No dietitians or admin yet.');
  } else if (a && ['admin', 'dietitian', 'member'].includes(b)) {
    try {
      const rows = await members.setRoleByEmail(a, b);
      console.log(rows.length ? `${rows[0].email} is now ${b === 'admin' ? 'the admin' : `a ${rows[0].role}`}.` : 'Not found. That person must open the app or the console and log in at least once first.');
      if (!rows.length) process.exitCode = 1;
    } catch (e) {
      if (e.code === '23505') { console.log('There is already an admin. Make them a member first: npm run role -- <their email> member'); process.exitCode = 1; }
      else throw e;
    }
  } else {
    console.log('Usage: npm run role -- <email> <admin|dietitian|member>   or   npm run role -- --list');
    process.exitCode = 1;
  }
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
