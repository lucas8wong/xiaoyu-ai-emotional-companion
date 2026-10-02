/**
 * Google 一键登录：ID token 验签单测。
 *
 * 做法：**自造 RSA 密钥 + 本地 JWKS 服务**（用 GOOGLE_JWKS_URL 覆盖 Google 的地址），
 * 走的仍是生产同一段验签代码，只是把公钥来源换成本地，既覆盖真实签名校验，
 * 又不依赖外网、不受 Google 密钥轮换影响。
 *
 * 覆盖的是「每一条防御对应的攻击」，不是覆盖率数字：算法混淆、未知 kid、签名篡改、
 * 换别人的私钥、过期、aud 不是本站、iss 不对、邮箱未验证。
 */

import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const KID = 'test-kid';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, alg: 'RS256', use: 'sig' };

type VerifyFn = (idToken: string) => Promise<
  { ok: true; claims: { sub: string; email: string; name?: string } } | { ok: false; error: string }
>;
let verify: VerifyFn;

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function sign(
  payload: Record<string, unknown>,
  opts: { alg?: string; kid?: string; key?: crypto.KeyObject } = {},
): string {
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? KID };
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = opts.alg === 'none'
    ? ''
    : crypto.sign('sha256', Buffer.from(signingInput), opts.key ?? privateKey).toString('base64url');
  return `${signingInput}.${sig}`;
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-sub-123',
    email: 'Tester@Gmail.com',
    email_verified: true,
    name: 'Tester',
    iat: nowSec - 10,
    exp: nowSec + 600,
    ...over,
  };
}

test('Google ID token 验签：正例 + 八条防御路径', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(() => { server.close(); });

  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_JWKS_URL = `http://127.0.0.1:${port}/certs`;
  // 动态 import：模块顶层的 GOOGLE_CLIENT_ID / JWKS_URL 正是在这一刻读取的
  const mod = await import('../../api/services/googleAuth.js');
  verify = mod.verifyGoogleIdToken;
  assert.strictEqual(mod.googleConfigured, true);

  // ① 正例：签名正确、aud/iss/exp/email_verified 全对
  const ok = await verify(sign(payload()));
  assert.strictEqual(ok.ok, true, '正例必须通过');
  if (ok.ok) {
    assert.strictEqual(ok.claims.sub, 'google-sub-123');
    assert.strictEqual(ok.claims.email, 'tester@gmail.com', '邮箱应统一小写');
    assert.strictEqual(ok.claims.name, 'Tester');
  }

  // ② alg=none（算法混淆：拿公钥当 HMAC 密钥那类攻击的起点）
  assert.strictEqual((await verify(sign(payload(), { alg: 'none' }))).ok, false, 'alg=none 必须拒绝');

  // ③ 未知 kid（应触发一次 JWKS 强刷后仍判失败）
  assert.strictEqual((await verify(sign(payload(), { kid: 'unknown-kid' }))).ok, false, '未知 kid 必须拒绝');

  // ④ 签名被篡改：改了 payload 但不重签
  const goodParts = sign(payload()).split('.');
  const tampered = `${goodParts[0]}.${b64(payload({ sub: 'attacker' }))}.${goodParts[2]}`;
  assert.strictEqual((await verify(tampered)).ok, false, '签名不匹配必须拒绝');

  // ⑤ 用**别人的私钥**签（结构完全合法，但公钥对不上 JWKS）
  const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.strictEqual((await verify(sign(payload(), { key: stranger.privateKey }))).ok, false, '外部密钥签名必须拒绝');

  // ⑥ 过期
  assert.strictEqual((await verify(sign(payload({ exp: Math.floor(Date.now() / 1000) - 3600 })))).ok, false, '过期必须拒绝');

  // ⑦ aud 不是本站（拿别家应用的 token 来登我们的站）
  assert.strictEqual((await verify(sign(payload({ aud: 'other.apps.googleusercontent.com' })))).ok, false, 'aud 不符必须拒绝');

  // ⑧ iss 不是 Google
  assert.strictEqual((await verify(sign(payload({ iss: 'https://evil.example.com' })))).ok, false, 'iss 不符必须拒绝');

  // ⑨ email_verified=false：不允许按邮箱匹配/建号（否则可用未验证邮箱抢占他人账号）
  assert.strictEqual((await verify(sign(payload({ email_verified: false })))).ok, false, '邮箱未验证必须拒绝');
});
