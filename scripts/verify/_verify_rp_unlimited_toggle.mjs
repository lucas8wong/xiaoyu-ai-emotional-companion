/**
 * 页面验证：剧情「无限制模式」开关是否出现在「我的偏好」面板里
 * 路径：深链直达剧情对话页 → 点顶栏「我的偏好」→ 面板内含 rpUnlimited 开关
 * 用法：node scripts/verify/_verify_rp_unlimited_toggle.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCENARIO = process.env.VERIFY_SCENARIO || 'guyushen-songzhi';
const URL = `http://127.0.0.1:3001/?open=roleplay&scenario=${SCENARIO}`;
const OUT = 'temp/verify-rp-unlimited';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

function seed(page) {
  return page.evaluateOnNewDocument(() => {
    try {
      for (const k of ['cure_privacy_agreed', 'cure_guide_seen', 'cure_ui_tour_seen', 'cure_reg_prompted',
        'cure_guest_prompted', 'cure_chat_coach_seen', 'cure_home_coach_seen', 'cure_rp_coach_seen',
        'cure_rp_intro_seen', 'cure_wy_coach_seen']) localStorage.setItem(k, '1');
      localStorage.setItem('cure_lang', 'zh-CN');
    } catch (e) { /* ignore */ }
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const errors = [];
for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 430, height: 932 }]]) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ` + String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ` + m.text().slice(0, 160)); });
  await seed(page);

  console.log(`\n--- ${name} ${vp.width}x${vp.height} ---`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);

  // 点顶栏「我的偏好」（aria-label / title 都是该文案）
  const opened = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || '') === '我的偏好');
    if (btn) { btn.click(); return true; }
    return false;
  });
  console.log('  找到并点击「我的偏好」：' + (opened ? '✓' : '✗'));
  await sleep(1200);

  const hasToggle = await page.evaluate(() => document.body.innerText.includes('无限制模式'));
  const hasHint = await page.evaluate(() => document.body.innerText.includes('不受平台内容限制'));
  // 开关的 aria 状态与可用性
  const sw = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button[role="switch"]'))
      .find((x) => (x.getAttribute('aria-label') || '') === '无限制模式');
    return b ? { checked: b.getAttribute('aria-checked'), disabled: b.getAttribute('aria-disabled') } : null;
  });
  console.log('  面板含「无限制模式」：' + (hasToggle ? '✓' : '✗'));
  console.log('  面板含说明文案：' + (hasHint ? '✓' : '✗'));
  console.log('  开关元素：' + (sw ? `aria-checked=${sw.checked} aria-disabled=${sw.disabled}` : '✗ 未找到'));

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log('  截图：' + `${OUT}/${name}.png`);
  await page.close();
}

await browser.close();
console.log('\n=== 页面 JS 错误 ===');
console.log(errors.length ? errors.join('\n') : '（无）');
