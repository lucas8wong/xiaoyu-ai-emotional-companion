import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { localConfig, localSecrets, saveLocalSecrets, wrangler } from './common.mjs';

try {
  const identity = wrangler(['whoami']);
  if (/not authenticated|not logged in|not currently logged/i.test(identity.stdout + identity.stderr)) {
    throw new Error('Cloudflare is not authorized. In this folder, run npm run login, complete the browser login/authorization, then rerun npm run setup.');
  }
  let config;
  if (existsSync(localConfig)) {
    config = JSON.parse((await import('node:fs')).readFileSync(localConfig, 'utf8'));
  } else {
    // Reuse an existing named monitor database after interruption; never create a replacement blindly.
    const listed = wrangler(['d1', 'list', '--json']);
    const first = listed.stdout.indexOf('['), last = listed.stdout.lastIndexOf(']');
    if (first < 0 || last < first) throw new Error('Cannot verify the existing Cloudflare database inventory.');
    const databases = JSON.parse(listed.stdout.slice(first, last + 1));
    const matches = databases.filter(item => item.name === 'qqqm-spym-monitor');
    if (matches.length > 1) throw new Error('Multiple monitor databases matched; resolve the ambiguous inventory before deployment.');
    let id = matches[0]?.uuid ?? matches[0]?.id;
    if (!id) {
      const created = wrangler(['d1', 'create', 'qqqm-spym-monitor']);
      id = created.stdout.match(/(?:database_id\s*[=:]\s*["']?|"database_id"\s*:\s*")([0-9a-f-]{36})/i)?.[1];
      if (!id) throw new Error('Database creation result could not be verified. Rerun setup to inspect and reuse the existing database.');
    }
    config = {
      name: 'qqqm-spym-monitor', main: 'src/worker.ts', compatibility_date: '2026-11-01', workers_dev: true,
      triggers: { crons: ['*/15 * * * *'] }, observability: { enabled: true },
      vars: { ENVIRONMENT: 'production' },
      d1_databases: [{ binding: 'DB', database_name: 'qqqm-spym-monitor', database_id: id, migrations_dir: 'migrations' }],
    };
    writeFileSync(localConfig, JSON.stringify(config, null, 2) + '\n');
  }
  const secrets = localSecrets();
  if (!secrets.ADMIN_TOKEN) secrets.ADMIN_TOKEN = randomBytes(32).toString('hex');
  saveLocalSecrets(secrets);
  console.log('Cloudflare database binding is ready. ADMIN_TOKEN is stored only in ignored .dev.vars.');
  console.log('Bind WeChat at https://sct.ftqq.com/ and put the Turbo SCT SendKey into SERVERCHAN_SENDKEY in .dev.vars. Do not paste it into chat.');
  console.log('Next: npm run deploy. Monitoring stays paused until cloud validation and the WeChat receipt code pass. No paid plan is enabled.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
