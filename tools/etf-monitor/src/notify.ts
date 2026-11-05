import { Store } from './store.js';
import type { Fetcher } from './types.js';

export function validSendKey(value: string): boolean {
  // This integration deliberately supports only the documented Turbo endpoint.
  return /^SCT[A-Za-z0-9]{10,200}$/.test(value);
}

async function providerResult(response: Response): Promise<unknown> {
  const limit = 16 * 1024;
  if (Number(response.headers.get('Content-Length') ?? 0) > limit) {
    await response.body?.cancel();
    throw new Error('Provider response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Provider response missing');
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('Provider response too large');
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  return JSON.parse(text);
}

export async function dispatchNotifications(store: Store, sendKey: string, nowMs: number, fetcher: Fetcher = fetch): Promise<{ sent: number; failed: number; ambiguous: number; remaining: number }> {
  if (!validSendKey(sendKey)) throw new Error('SERVERCHAN_SENDKEY must be a valid Turbo SCT key');
  let sent = 0;
  let failed = 0;
  let ambiguous = 0;
  for (let count = 0; count < 5; count++) {
    const item = await store.reserveNotification(nowMs);
    if (!item) break;
    let code: number | null = null;
    let outcome: 'accepted' | 'rejected' | 'permanent' | 'ambiguous' = 'ambiguous';
    try {
      const response = await fetcher(`https://sctapi.ftqq.com/${sendKey}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ title: item.title, desp: item.body }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      const result = await providerResult(response);
      if (result && typeof result === 'object' && 'code' in result && typeof result.code === 'number' && Number.isSafeInteger(result.code)) {
        code = result.code;
        if (response.ok && code === 0) outcome = 'accepted';
        else if (code !== 0) {
          // Inspect only to classify; never persist provider text or exceptions,
          // which can contain a URL with the SendKey.
          const message = 'message' in result && typeof result.message === 'string' ? result.message : '';
          const invalidKey = /(?:sendkey|send key|密钥|\bkey\b).{0,40}(?:invalid|incorrect|not exist|无效|不存在|错误)|(?:invalid|incorrect).{0,20}(?:sendkey|send key|\bkey\b)/i.test(message);
          outcome = invalidKey || response.status === 401 || response.status === 403 ? 'permanent' : 'rejected';
        }
      } else if (response.status === 401 || response.status === 403) {
        outcome = 'permanent';
      }
    } catch {
      // Lost response does not mean rejected. No automatic duplicate send.
      outcome = 'ambiguous';
    }
    await store.finishNotification(item.attemptId, outcome, nowMs, code);
    if (outcome === 'accepted') sent++;
    else if (outcome === 'ambiguous') ambiguous++;
    else failed++;
    // An invalid/disabled key applies to the channel, so stop this invocation.
    if (outcome === 'permanent') break;
  }
  return { sent, failed, ambiguous, remaining: await store.pendingCount(nowMs) };
}
