import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3001/';
const OUT = 'temp/verify-scroll-stream';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// 模拟聊一聊流式回复（SSE）：一次返回全部 delta，前端 runReveal 按打字机节奏逐字揭示，
// 因此会在数秒内持续触发自动滚动 —— 用于验证「流式中用户上滑不会被拽回」。
const paras = [];
for (let i = 1; i <= 12; i++) {
  paras.push(`第${i}段。这是一段为了验证流式滚动而拉得足够长的内容，让消息区明显溢出，${i}号段落在这里。`);
}
const reply = paras.join('\n\n');
const events = (() => {
  const out = [];
  for (let i = 0; i < paras.length; i++) {
    out.push({ type: 'delta', content: (i === 0 ? '' : '\n\n') + paras[i] });
  }
  out.push({ type: 'done', data: { sessionId: 'mock-sess', reply, title: '测试会话' } });
  return out;
})();
const SSE = events.map((e) => 'data: ' + JSON.stringify(e) + '\n').join('');

const SCROLL_SEL = 'div[class*="overflow-y-auto"][class*="bg-brand"][class*="space-y-3"]';

async function clickText(page, text, timeout = 60000) {
  await page.waitForFunction((q) => {
    return Array.from(document.querySelectorAll('button, a'))
      .some((b) => b.textContent && b.textContent.indexOf(q) !== -1);
  }, { timeout }, text);
  await page.evaluate((q) => {
    const els = Array.from(document.querySelectorAll('button, a'))
      .filter((b) => b.textContent && b.textContent.indexOf(q) !== -1);
    if (els.length) els[els.length - 1].click();
  }, text);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=390,844'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
const cons = [];
page.on('console', (m) => { if (m.type() === 'error') cons.push(m.text()); });
page.on('pageerror', (e) => cons.push('PAGEERROR: ' + String(e)));

await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('/api/analysis/chat/stream')) {
    req.respond({ status: 200, contentType: 'text/event-stream', headers: { 'Cache-Control': 'no-cache' }, body: SSE });
  } else {
    req.continue();
  }
});

await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('cure_lang', 'zh-CN');
    localStorage.setItem('cure_privacy_agreed', '1');
    localStorage.setItem('cure_guide_seen', '1');
    localStorage.setItem('cure_ui_tour_seen', '1');
    localStorage.setItem('cure_reg_prompted', '1');
    localStorage.setItem('cure_guest_prompted', '1');
    localStorage.setItem('cure_chat_coach_seen', '1');
    localStorage.setItem('cure_home_coach_seen', '1');
    localStorage.setItem('cure_rp_coach_seen', '1');
    localStorage.setItem('cure_rp_intro_seen', '1');
    localStorage.setItem('cure_wy_coach_seen', '1');
  } catch (e) { /* ignore */ }
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await sleep(1500);

await clickText(page, '聊一聊');
await page.waitForFunction(() => document.querySelector('textarea') != null, { timeout: 60000 });
await sleep(800);

await page.evaluate(() => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '你好，想聊聊最近的事');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === '发送');
  if (b) b.click();
});

await page.waitForFunction(() => document.body.textContent.includes('第1段'), { timeout: 60000 });

const measure = () => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  return { found: true, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, distFromBottom: dist, atBottom: dist < 80 };
}, SCROLL_SEL);

await page.waitForFunction((sel) => {
  const el = document.querySelector(sel);
  return !!el && el.scrollHeight - el.clientHeight > 180;
}, { timeout: 30000 }, SCROLL_SEL);
const stillStreaming = await page.evaluate((last) => document.body.textContent.indexOf(last) === -1, '第12段');
const before = await measure();

// 模拟用户上滑：触发 onWheel（置 userScrolling）+ 上滚
await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return;
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }));
  el.scrollTop = Math.max(0, el.scrollTop - 300);
}, SCROLL_SEL);
await sleep(250);
const afterScroll = await measure();
const shot1 = OUT + '/scrolled-up-streaming.png';
await page.screenshot({ path: shot1, fullPage: false });

await sleep(1200);
const later = await measure();
const shot2 = OUT + '/reveal-continues.png';
await page.screenshot({ path: shot2, fullPage: false });

const hasBackBtn = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('button')).some((b) => b.textContent && b.textContent.indexOf('回到最新') !== -1);
});

console.log('STILL_STREAMING=' + stillStreaming);
console.log('BEFORE=' + JSON.stringify(before));
console.log('AFTER_SCROLL=' + JSON.stringify(afterScroll));
console.log('LATER=' + JSON.stringify(later));
console.log('HAS_BACK_BTN=' + hasBackBtn);
console.log('CONSOLE_ERRORS=' + JSON.stringify(cons));
console.log('SHOTS=' + JSON.stringify([shot1, shot2]));

await page.close();
await browser.close();
