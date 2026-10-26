import { createHash } from 'node:crypto';

const pending = new Map<string, Promise<unknown>>();
/** Only coalesce identical in-flight work for the same user. Never retain results. */
export function coalesceAuxiliary<T>(userId: string, identity: readonly string[], work: () => Promise<T>): Promise<T> {
  if (!userId) return work();
  const key = createHash('sha256').update(JSON.stringify([userId, ...identity])).digest('hex');
  const active = pending.get(key);
  if (active) return active as Promise<T>;
  if (pending.size >= 128) return work();
  const promise = Promise.resolve().then(work).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
  pending.set(key, promise);
  return promise;
}
