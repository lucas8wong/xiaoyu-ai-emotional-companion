import { createInterface } from 'node:readline/promises';
import { localSecrets, safeUrl, adminRequest } from './common.mjs';

try {
  const urlIndex = process.argv.indexOf('--url');
  const origin = safeUrl(urlIndex >= 0 ? process.argv[urlIndex + 1] : process.env.MONITOR_URL);
  const { ADMIN_TOKEN } = localSecrets();
  await adminRequest(origin, ADMIN_TOKEN, '/admin/pause', {});
  const validation = await adminRequest(origin, ADMIN_TOKEN, '/admin/validate', {});
  if (!validation.valid) throw new Error('Cloud-side price validation failed; monitoring stays paused.');
  if (!process.stdin.isTTY) throw new Error('Run activation in an interactive terminal so you can enter the code read from WeChat.');
  const test = await adminRequest(origin, ADMIN_TOKEN, '/admin/test-push', {});
  if (test.sent !== 1) throw new Error('The provider has not accepted the test. Check status/remaining daily quota; monitoring stays paused.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let code;
  try { code = (await prompt.question('请输入微信消息中实际收到的6位验证码：')).trim(); }
  finally { prompt.close(); }
  await adminRequest(origin, ADMIN_TOKEN, '/admin/confirm-delivery', { testId: test.testId, code });
  const result = await adminRequest(origin, ADMIN_TOKEN, '/admin/enable', {});
  console.log(JSON.stringify(result));
  console.log('Monitoring is enabled in the cloud. Daily combined briefing: 08:00 Beijing; confirmed close signals are sent separately.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
