import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root, localConfig, localSecrets, loadConfig, wrangler, adminRequest } from './common.mjs';

try {
  loadConfig();
  const secrets = localSecrets();
  if (secrets.ADMIN_TOKEN.length < 32 || !/^SCT[A-Za-z0-9]{10,200}$/.test(secrets.SERVERCHAN_SENDKEY)) throw new Error('Configure ADMIN_TOKEN and SERVERCHAN_SENDKEY in ignored .dev.vars before deployment.');
  const runNode = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error('Local checks failed; deployment stopped.');
  };
  runNode([join(root, 'node_modules/typescript/bin/tsc'), '--noEmit']);
  runNode(['--import', 'tsx', '--test', '--test-concurrency=1', 'test/*.test.ts']);
  wrangler(['deploy', '--dry-run', '--outdir', '.build', '--config', localConfig]);
  wrangler(['d1', 'migrations', 'apply', 'qqqm-spym-monitor', '--remote', '--config', localConfig]);
  wrangler(['d1', 'execute', 'qqqm-spym-monitor', '--remote', '--config', localConfig, '--command',
    "UPDATE monitor_values SET value = json_set(value, '$.enabled', json('false')) WHERE key = 'control'"]);
  const previous = process.env.MONITOR_URL;
  // On upgrades pause the existing monitor before changing its code/secrets.
  if (previous) await adminRequest(previous, secrets.ADMIN_TOKEN, '/admin/pause', {});
  const deployment = wrangler(['deploy', '--config', localConfig]);
  for (const name of ['ADMIN_TOKEN', 'SERVERCHAN_SENDKEY']) wrangler(['secret', 'put', name, '--config', localConfig], { input: secrets[name] + '\n' });
  const origin = deployment.stdout.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev\b/)?.[0] ?? previous;
  if (!origin) throw new Error('Deployment returned no verifiable Worker URL. Read the Cloudflare dashboard and use npm run activate -- --url URL. Monitoring is not enabled.');
  await adminRequest(origin, secrets.ADMIN_TOKEN, '/admin/pause', {});
  const validation = await adminRequest(origin, secrets.ADMIN_TOKEN, '/admin/validate', {});
  if (!validation.valid) throw new Error('Cloud-side price validation failed. Monitoring remains paused; inspect /admin/status.');
  console.log(`Deployed and cloud price validation passed: ${origin}`);
  console.log(`Next: npm run activate -- --url ${origin}`);
  console.log('The activation command sends one test message and requires the code actually received in WeChat before enabling monitoring.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
