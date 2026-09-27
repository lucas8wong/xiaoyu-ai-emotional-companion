/**
 * 无头浏览器验证：四套皮肤（healing/zen/star/candy）「了解小愈」页字标渲染尺寸一致。
 * 用法：node scripts/verify-wordmark.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3001';
const SKINS = ['healing', 'zen', 'star', 'candy'];
const OUT = 'temp/verify-wordmark';
const SEEN_KEYS = ['cure_home_coach_seen', 'cure_ui_tour_seen', 'cure_chat_coach_seen', 'cure_rp_coach_seen', 'cure_wy_coach_seen', 'cure_install_coach_seen', 'cure_install_banner_seen'];

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });

async function markSeen(page) {
  await page.evaluate((keys) => {
    for (const k of keys) localStorage.setItem(k, '1');
  }, SEEN_KEYS);
}

// 预热一页，清掉首次进入的 coach/安装引导，避免阻塞后续点击
const warm = await browser.newPage();
await warm.setViewport({ width: 390, height: 844 });
await warm.goto(BASE, { waitUntil: 'networkidle2' });
await markSeen(warm);
await warm.goto(BASE, { waitUntil: 'networkidle2' });
await markSeen(warm);
await sleep(1500);
await warm.close();

for (const skin of SKINS) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await markSeen(page);
    await page.evaluate((s) => {
      localStorage.setItem('cure_skin', s);
      localStorage.setItem('cure_skin_version', '2');
    }, skin);
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await markSeen(page);
    await sleep(1200);

    const aboutBtn = await page.waitForSelector('button[aria-label="了解小愈"], button[aria-label="About Xiaoyu"]', { timeout: 20000 });
    const b = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '了解小愈' || x.getAttribute('aria-label') === 'About Xiaoyu');
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);

    let imgOk = false;
    try {
      await page.waitForSelector('img[src*="wordmark"]', { timeout: 12000 });
      await page.waitForFunction(() => {
        const im = document.querySelector('img[src*="wordmark"]');
        return im && im.complete && im.naturalWidth > 0;
      }, { timeout: 12000 });
      imgOk = true;
    } catch { imgOk = false; }

    const info = await page.evaluate(() => {
      const im = document.querySelector('img[src*="wordmark"]');
      const r = im ? im.getBoundingClientRect() : null;
      return {
        dataSkin: document.documentElement.getAttribute('data-skin'),
        src: im ? im.getAttribute('src') : null,
        blend: im ? im.className.includes('mix-blend-multiply') : null,
        rect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
        heading: document.body.innerText.slice(0, 90),
      };
    });

    console.log(`[${skin}#${attempt + 1}] data-skin=${info.dataSkin} img=${imgOk} src=${info.src} tile=${JSON.stringify(info.rect)} blend=${info.blend} errors=${errors.length ? errors.join('|') : 'none'}`);

    if (imgOk && info.rect) {
      const rect = await page.$eval('img[src*="wordmark"]', (im) => {
        const r = im.getBoundingClientRect();
        return { x: r.x - 16, y: Math.max(0, r.y - 16), width: r.width + 32, height: r.height + 32 };
      });
      await page.screenshot({ path: `${OUT}/${skin}.png`, clip: rect });
    }
    await page.close();

    if (imgOk) break; // 成功则不再重试
    console.log(`[${skin}] retrying...`);
  }
}

await browser.close();
console.log('✅ verify done');
