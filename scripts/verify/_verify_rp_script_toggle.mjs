/**
 * 页面验证：剧本生成处的「用无限制模型生成剧本」开关
 * 路径：?open=roleplay → 点「AI 创剧本」→ 表单内含该开关
 * 用法：node scripts/verify/_verify_rp_script_toggle.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = 'temp/verify-rp-script-toggle';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];

for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 430, height: 932 }]]) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ` + String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ` + m.text().slice(0, 160)); });
  await page.evaluateOnNewDocument(() => {
    try {
      for (const k of ['cure_privacy_agreed', 'cure_guide_seen', 'cure_ui_tour_seen', 'cure_reg_prompted',
        'cure_guest_prompted', 'cure_chat_coach_seen', 'cure_home_coach_seen', 'cure_rp_coach_seen',
        'cure_rp_intro_seen', 'cure_wy_coach_seen']) localStorage.setItem(k, '1');
      localStorage.setItem('cure_lang', 'zh-CN');
    } catch (e) { /* ignore */ }
  });

  console.log(`\n--- ${name} ${vp.width}x${vp.height} ---`);
  await page.goto('http://127.0.0.1:3001/?open=roleplay', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);

  // 点「AI 创剧本」进入创建表单
  const opened = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .find((b) => (b.textContent || '').includes('AI 创剧本'));
    if (el) { el.click(); return true; }
    return false;
  });
  console.log('  点击「AI 创剧本」：' + (opened ? '✓' : '✗'));
  await sleep(2200);

  const hasToggle = await page.evaluate(() => document.body.innerText.includes('用无限制模型生成剧本'));
  const hasHint = await page.evaluate(() => document.body.innerText.includes('不会被净化成纯情清水'));
  const needAdult = await page.evaluate(() => document.body.innerText.includes('需先完成 18+ 成年确认'));
  const sw = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button[role="switch"]'))
      .find((x) => (x.getAttribute('aria-label') || '') === '用无限制模型生成剧本');
    return b ? { checked: b.getAttribute('aria-checked'), disabled: b.getAttribute('aria-disabled') } : null;
  });
  console.log('  含「用无限制模型生成剧本」：' + (hasToggle ? '✓' : '✗'));
  console.log('  含说明文案：' + (hasHint ? '✓' : '✗'));
  console.log('  未过成年确认时显示提示：' + (needAdult ? '✓' : '（未显示）'));
  console.log('  开关元素：' + (sw ? `aria-checked=${sw.checked} aria-disabled=${sw.disabled}` : '✗ 未找到'));

  // 把开关所在区块滚进视野再截图，否则截图里看不到
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('p')).find((p) => (p.textContent || '').includes('用无限制模型生成剧本'));
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
  });
  await sleep(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('  截图：' + `${OUT}/${name}.png`);
  await page.close();
}

await browser.close();
console.log('\n=== 页面 JS 错误 ===');
console.log(errors.length ? errors.slice(0, 6).join('\n') : '（无）');
