import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const localConfig = join(root, 'wrangler.local.json');
export function wranglerEnvironment() {
  return { ...process.env, WRANGLER_SEND_METRICS: 'false',
    XDG_CONFIG_HOME: join(root, '.wrangler', 'profile'),
    WRANGLER_LOG_PATH: join(root, '.wrangler', 'logs', 'deploy.log') };
}
export function wranglerInteractive(args) {
  mkdirSync(join(root, '.wrangler', 'logs'), { recursive: true });
  const result = spawnSync(process.execPath, [join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args], {
    cwd: root, env: wranglerEnvironment(), stdio: 'inherit', windowsHide: true,
  });
  if (result.status !== 0 || result.error) throw new Error('Cloudflare command did not complete.');
}
export function localSecrets() {
  const path = join(root, '.dev.vars');
  const saved = existsSync(path) ? Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+\s*=/.test(line)).map(line => {
    const i = line.indexOf('=');
    let value = line.slice(i + 1).trim();
    if (/^".*"$/.test(value)) value = JSON.parse(value);
    return [line.slice(0, i).trim(), value];
  })) : {};
  return { ADMIN_TOKEN: process.env.ADMIN_TOKEN || saved.ADMIN_TOKEN || '', SERVERCHAN_SENDKEY: process.env.SERVERCHAN_SENDKEY || saved.SERVERCHAN_SENDKEY || '' };
}
export function saveLocalSecrets(secrets) {
  writeFileSync(join(root, '.dev.vars'), Object.entries(secrets).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
}
export function wrangler(args, { input, allowFailure = false } = {}) {
  mkdirSync(join(root, '.wrangler', 'logs'), { recursive: true });
  const result = spawnSync(process.execPath, [join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args], {
    cwd: root, encoding: 'utf8', input,
    env: wranglerEnvironment(),
    windowsHide: true,
  });
  if ((result.status !== 0 || result.error) && !allowFailure) throw new Error(`Cloudflare ${args[0]} failed. Check the local ignored .wrangler/logs/deploy.log; credentials are never printed here.`);
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
export function loadConfig() {
  if (!existsSync(localConfig)) throw new Error('Run npm run setup first. Cloudflare authorization is required.');
  const config = JSON.parse(readFileSync(localConfig, 'utf8'));
  if (!/^[0-9a-f-]{36}$/i.test(config.d1_databases?.[0]?.database_id ?? '') || /^0{8}-/.test(config.d1_databases[0].database_id)) throw new Error('Cloudflare D1 binding has not been provisioned.');
  return config;
}
export function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.port || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Use your HTTPS workers.dev origin without credentials, paths or query parameters.');
  }
  return url.origin;
}
export async function adminRequest(origin, token, path, body) {
  if (token.length < 32) throw new Error('ADMIN_TOKEN is not configured.');
  const response = await fetch(`${safeUrl(origin)}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Worker returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`Worker check failed: ${result.error || `HTTP ${response.status}`}`);
  return result;
}
