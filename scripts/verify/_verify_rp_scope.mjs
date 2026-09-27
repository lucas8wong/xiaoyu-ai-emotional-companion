/**
 * 页面验证：剧情模式「内容尺度」告知弹窗
 * 走深链 ?open=roleplay&scenario=<id> 直达剧本详情 → 点「开始这段剧情」→ 弹窗出现 → 截图
 * 用法：node scripts/verify/_verify_rp_scope.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCENARIO = process.env.VERIFY_SCENARIO || 'guyushen-songzhi';
const URL = `http://127.0.0.1:3001/?open=roleplay&scenario=${SCENARIO}`;
const OUT = 'temp/verify-rp-scope';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

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
    const els = Array.from(document.querySelectorAll('button, a'))
      .filter((b) => b.textContent && b.textContent.indexOf(q) !== -1);
    if (els.length) els[els.length - 1].click();
  }, text);
}

/**
 * 点「任意含该文本的元素」——剧本卡片通常是 div + onClick，不是 <button>。
 * 做法：找到最内层含文本的元素，再向上找第一个可点击祖先。
 */
async function clickAnyText(page, text, timeout = 30000) {
  await page.waitForFunction((q) => document.body.innerText.indexOf(q) !== -1, { timeout }, text);
  const ok = await page.evaluate((q) => {
    const all = Array.from(document.querySelectorAll('body *'));
    const leaf = all.filter((e) => e.children.length === 0 && (e.textContent || '').includes(q));
    for (const el of leaf) {
      let n = el;
      for (let i = 0; i < 8 && n; i++) {
        if (n.tagName === 'BUTTON' || n.tagName === 'A' || n.getAttribute('role') === 'button') { n.click(); return true; }
        n = n.parentElement;
      }
      // 没有可点击祖先时，直接派发点击到最内层
      el.click();
      return true;
    }
    return false;
  }, text);
  return ok;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const errors = [];
for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 430, height: 932 }]]) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ` + m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ` + String(e).slice(0, 160)));
  await seed(page);

  console.log(`\n--- ${name} ${vp.width}x${vp.height} ---`);
  // 先到剧情模式列表页（不要带 scenario 参数，否则会直接进对话页、跳过详情页）
  await page.goto('http://127.0.0.1:3001/?open=roleplay', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);

  // 1) 从列表点进剧本详情页
  const TITLE = process.env.VERIFY_TITLE || '他等了我十五年';
  const entered = await clickAnyText(page, TITLE, 20000).catch(() => false);
  console.log('  点剧本卡片「' + TITLE + '」：' + (entered ? '✓' : '✗'));
  await sleep(2000);

  // 2) 详情页点「开始这段剧情」/「继续剧情」触发内容尺度弹窗
  let clicked = false;
  for (const label of ['开始这段剧情', '继续剧情']) {
    try { await clickText(page, label, 6000); clicked = true; console.log('  已点击：' + label); break; }
    catch { /* 换下一个 */ }
  }
  if (!clicked) {
    console.log('  ✗ 没找到入口按钮，当前可见按钮：');
    console.log('   ', await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim().slice(0, 24)).filter(Boolean).slice(0, 25).join(' | ')));
  }
  await sleep(1200);

  const hasScope = await page.evaluate(() => document.body.innerText.includes('内容尺度'));
  const hasAdult = await page.evaluate(() => document.body.innerText.includes('未满 18 岁'));
  console.log('  弹窗含「内容尺度」标题：' + (hasScope ? '✓' : '✗'));
  console.log('  弹窗含 18+ 提示：' + (hasAdult ? '✓' : '✗'));

  const shot = `${OUT}/${name}.png`;
  await page.screenshot({ path: shot, fullPage: false });
  console.log('  截图：' + shot);

  // 抓弹窗区域的文字（用于核对文案真的渲染出来）
  const modalText = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('div'));
    const hit = all.find((d) => d.innerText && d.innerText.includes('内容尺度') && d.innerText.length < 900);
    return hit ? hit.innerText.trim() : '(未匹配到弹窗容器)';
  });
  fs.writeFileSync(`${OUT}/${name}.txt`, modalText, 'utf8');
  console.log('  弹窗文本已存 ' + `${OUT}/${name}.txt`);

  // 几何自检：确认没有元素重叠、没有被裁剪
  const geo = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('p'));
    const body = ps.find((p) => p.textContent.includes('本模式支持成年角色'));
    const adult = ps.find((p) => p.textContent.includes('未满 18 岁'));
    const modal = body ? body.closest('div[class*="rounded-2xl"]') : null;
    const r = (el) => { const b = el && el.getBoundingClientRect(); return b ? { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) } : null; };
    return {
      bodyRect: r(body), adultRect: r(adult),
      overlapPx: (body && adult) ? Math.max(0, Math.round(body.getBoundingClientRect().bottom - adult.getBoundingClientRect().top)) : null,
      modalClient: modal ? modal.clientHeight : null,
      modalScroll: modal ? modal.scrollHeight : null,
      viewportH: window.innerHeight,
    };
  });
  console.log('  几何：正文 ' + JSON.stringify(geo.bodyRect) + ' / 18+ ' + JSON.stringify(geo.adultRect));
  console.log('  正文与 18+ 行的重叠像素：' + geo.overlapPx + (geo.overlapPx > 0 ? '  ⚠️ 有重叠' : '  ✓ 无重叠'));
  console.log('  弹窗 client/scroll/视口高：' + geo.modalClient + '/' + geo.modalScroll + '/' + geo.viewportH
    + (geo.modalScroll > geo.modalClient ? '  ⚠️ 内容溢出被裁剪' : '  ✓ 未溢出'));
  await page.close();
}

await browser.close();
console.log('\n=== 页面 JS 错误 ===');
console.log(errors.length ? errors.join('\n') : '（无）');
