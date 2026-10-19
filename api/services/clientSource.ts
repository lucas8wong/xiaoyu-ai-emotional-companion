import type { Request } from 'express';

export const CLIENT_KINDS = ['web', 'ios-web', 'ios-home', 'android-app', 'unknown'] as const;
export type ClientKind = typeof CLIENT_KINDS[number];
export interface ClientSource { kind: ClientKind; version?: string }

/** Analytics hint only, never an authentication/permission/payment signal. */
export function requestClientSource(req: Pick<Request, 'headers' | 'body'>): ClientSource {
  const ua = String(req.headers['user-agent'] || '');
  const raw = req.headers['x-xiaoyu-client'] ?? req.body?.client;
  const kind: ClientKind = /\bXiaoyuAndroid\//.test(ua) ? 'android-app'
    : CLIENT_KINDS.includes(raw as ClientKind) ? raw as ClientKind : 'unknown';
  // Older APKs use a fixed 1.1 UA suffix, which is not their actual release version.
  const version = req.headers['x-xiaoyu-version'] ?? req.body?.appVersion;
  return { kind, ...(kind === 'android-app' && typeof version === 'string' && /^[0-9]{1,8}(\.[0-9]{1,8}){1,3}$/.test(version) ? { version } : {}) };
}

export interface ClientUsageBucket {
  daily: Record<string, number>;
  logins: Record<string, number>;
  lastAt: number;
  lastLoginAt: number;
  version?: string;
}
export type ClientUsageBuckets = Partial<Record<ClientKind, ClientUsageBucket>>;
export interface ClientUsageRow extends ClientSource { seconds: number; logins: number; lastAt: number; lastLoginAt: number }

/** UTC+8 matches the production daily accounting boundary, independently of host TZ. */
export function clientDate(at: number): string { return new Date(at + 8 * 3600_000).toISOString().slice(0, 10); }

export function mergeClientUsage(rows: ClientUsageRow[]): ClientUsageRow[] {
  const map = new Map<ClientKind, ClientUsageRow>();
  for (const row of rows) {
    const prev = map.get(row.kind);
    if (!prev) { map.set(row.kind, { ...row }); continue; }
    map.set(row.kind, { ...(row.lastAt > prev.lastAt ? row : prev), seconds: prev.seconds + row.seconds,
      logins: prev.logins + row.logins, lastAt: Math.max(prev.lastAt, row.lastAt), lastLoginAt: Math.max(prev.lastLoginAt, row.lastLoginAt) });
  }
  return CLIENT_KINDS.flatMap(kind => map.has(kind) ? [map.get(kind)!] : []);
}

export function clientUsageStats(users: Array<{ account: boolean; clientUsage: ClientUsageRow[] }>) {
  return CLIENT_KINDS.map(kind => {
    const found = users.flatMap(user => {
      const usage = user.clientUsage.find(row => row.kind === kind);
      return usage ? [{ ...usage, account: user.account }] : [];
    });
    return { kind, identities: found.length, accounts: found.filter(row => row.account).length,
      guests: found.filter(row => !row.account).length, loginAccounts: found.filter(row => row.account && row.logins > 0).length,
      logins: found.reduce((sum, row) => sum + row.logins, 0), seconds: found.reduce((sum, row) => sum + row.seconds, 0) };
  });
}
