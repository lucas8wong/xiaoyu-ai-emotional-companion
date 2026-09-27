import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3001/';
const OUT = 'temp/verify-link-card';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const REPLY =
  '给你两篇讲微信 QQ 液态玻璃图标的文章：\n' +
  'news.qq.com/rain/a/20251226A03V7S00 和 https://m.huxiu.com/article/4820644.html';

const SSE_LINES = [
  'data: ' + JSON.stringify({ type: 'delta', content: '给你两篇讲微信 QQ 液态玻璃图标的文章：' }),
  'data: ' + JSON.stringify({ type: 'delta', content: '\nnews.qq.com/rain/a/20251226A03V7S00 和 https://m.huxiu.com/article/4820644.html' }),
  'data: ' + JSON.stringify({ type: 'done', data: { sessionId: 'test-linkcard', reply: REPLY, title: '测试' } }),
  '',
].join('\n');

function seed(page) {
  return page.evaluateOnNewDocument(() => {
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
}

async function clickText(page, text, timeout = 30000) {
  await page.waitForFunction((q) => {
    return Array.from(document.querySelectorAll('button, a'))
      .some((b) => b.textContent && b.textContent.indexOf(q) !== -1);
  }, { timeout }, text);
  await page.evaluate((q) => {
    const el = Array.from(document.querySelectorAll('button, a'))
      .find((b) => b.textContent && b.textContent.indexOf(q) !== -1);
    if (el) el.click();
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
    req.respond({ status: 200, contentType: 'text/event-stream', body: SSE_LINES });
  } else {
    req.continue();
  }
});

await seed(page);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await clickText(page, '聊一聊');

// 等聊天输入框出现（用带 placeholder 的 textarea 精确定位，避开角色表单里可能存在的 textarea）
await page.waitForSelector('textarea[placeholder]', { timeout: 30000 });
await page.type('textarea[placeholder]', '推荐两篇讲液态玻璃图标的文章');
await page.keyboard.press('Enter');

// 等待 assistant 气泡里的两个链接卡片渲染
await page.waitForSelector('a[href="https://news.qq.com/rain/a/20251226A03V7S00"]', { timeout: 30000 });
await page.waitForSelector('a[href="https://m.huxiu.com/article/4820644.html"]', { timeout: 30000 });

// 等卡片缩略图加载完成（至少一张图成功解码）
let imgOk = false;
const t0 = Date.now();
while (Date.now() - t0 < 15000) {
  imgOk = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="huxiu"], a[href*="qq.com"] img'))
      .some((img) => img.complete && img.naturalWidth > 0);
  });
  if (imgOk) break;
  await sleep(300);
}

await sleep(800);
const shot = OUT + '/link-card.png';
await page.screenshot({ path: shot, fullPage: false });

const summary = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll('a[href*="huxiu"], a[href*="news.qq.com"]'))
    .filter((a) => a.className && a.className.indexOf('w-[') !== -1);
  return {
    cards: cards.length,
    titles: cards.map((a) => (a.querySelector('div') ? a.textContent.trim() : '')),
    imgOk: Array.from(document.querySelectorAll('a img')).some((img) => img.complete && img.naturalWidth > 0),
  };
});

await page.close();
await browser.close();

console.log('SHOT=' + shot);
console.log('IMG_OK=' + imgOk);
console.log('SUMMARY=' + JSON.stringify(summary));
console.log('CONSOLE_ERRORS=' + JSON.stringify(cons));
