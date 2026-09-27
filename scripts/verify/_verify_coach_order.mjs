import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:5173/';
const OUT = 'temp/coach_order';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// 期望顺序：每个页面依次出现的气泡文案（zh-CN），C 方案 = 自上而下兜底 + 最后=主入口
const EXPECT = {
  chat: [
    '这里开新对话、切换历史对话',                 // history（顶栏左）
    '点这里创建 / 切换角色，还能打开观景窗看 TA 的内心', // role（顶栏中）
    '这里打开「更多」：偏好 / 意见反馈',            // more（顶栏右）
    '到这里把情绪一步步理清楚',                    // sort / 理一理（顶栏右）
    '发图片给我看，我也能看懂',                    // image（底部输入栏）→ 主入口收尾
  ],
  home: [
    '个性化偏好 / 换皮肤 / 我的记录 都在这里',      // more（顶栏）
    '每天打个卡，记下今天的心情',                  // mood（顶栏）
    '想体验剧情就点这里',                         // roleplay（剧情卡）
    '心事想理清楚，从这里进理一理',                // sort / 理一理
    '点这里，随时有人陪你聊',                     // chat（聊一聊卡）→ 主入口收尾
  ],
  roleplay: [
    '想了解剧情模式？点这里看介绍',                // intro ⓘ（顶部）
    'AI 文游：人生模拟，活过千种人生',             // wenyou（切换 tab）
    '想要自己的故事？点这里创建剧本',              // create（自建剧本）
    '角色剧情扮演模式',                          // mode（切换起始 tab）→ 主入口收尾
  ],
  wenyou: [
    '命书阁：回顾已历结局与成就',                  // archive（命书阁）
    '输入主题，AI 为你写剧本（Pro）',              // gen（AI 生成）
    '选一个剧本，开始一世人生',                   // scenario（选剧本）→ 主入口收尾
  ],
};

// 各个页面进入前的 localStorage 种子（清掉目标 coach 的 seen；抑制其它弹窗/导览/横幅）
function seedFor(page, mode) {
  return page.evaluateOnNewDocument((m) => {
    try {
      localStorage.setItem('cure_lang', 'zh-CN');
      localStorage.setItem('cure_privacy_agreed', '1'); // 隐藏底部隐私横幅
      localStorage.setItem('cure_guide_seen', '1');
      localStorage.setItem('cure_ui_tour_seen', '1');
      localStorage.setItem('cure_reg_prompted', '1');
      localStorage.setItem('cure_guest_prompted', '1');
      localStorage.setItem('cure_chat_coach_seen', '1');
      localStorage.setItem('cure_home_coach_seen', '1');
      localStorage.setItem('cure_rp_coach_seen', '1');
      localStorage.setItem('cure_rp_intro_seen', '1');
      localStorage.setItem('cure_wy_coach_seen', '1');
      // 只清掉要验证的那个 coach
      if (m === 'chat') localStorage.removeItem('cure_chat_coach_seen');
      if (m === 'home') localStorage.removeItem('cure_home_coach_seen');
      if (m === 'roleplay') localStorage.removeItem('cure_rp_coach_seen');
      if (m === 'wenyou') localStorage.removeItem('cure_wy_coach_seen');
    } catch (e) { /* ignore */ }
  }, mode);
}

function readBubble(page) {
  return page.evaluate(() => {
    // 找到「跳过」按钮所在的气泡容器，取其中的 <p> 文案
    const btns = Array.from(document.querySelectorAll('button'));
    const skip = btns.find((b) => b.textContent && b.textContent.indexOf('跳过') !== -1);
    if (!skip) return null;
    let el = skip.closest('div[class*="rounded-2xl"]');
    if (!el) return null;
    const p = el.querySelector('p');
    return p ? p.textContent.trim() : null;
  });
}

async function waitBubble(page, expected, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const t = await readBubble(page);
    if (t && t === expected) return true;
    await sleep(200);
  }
  return false;
}

async function clickAdvance(page) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((btn) => {
        const txt = (btn.textContent || '').trim();
        return (txt === '下一个' || txt === '开始聊聊');
      });
    if (b) b.click();
  });
}

async function clickText(page, text, timeout = 30000) {
  await page.waitForFunction((q) => {
    return Array.from(document.querySelectorAll('button'))
      .some((b) => b.textContent && b.textContent.indexOf(q) !== -1);
  }, { timeout }, text);
  await page.evaluate((q) => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((btn) => btn.textContent && btn.textContent.indexOf(q) !== -1);
    if (b) b.click();
  }, text);
}

async function runPage(browser, mode) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const cons = [];
  page.on('console', (m) => { if (m.type() === 'error') cons.push(m.text()); });
  page.on('pageerror', (e) => cons.push('PAGEERROR: ' + String(e)));
  await seedFor(page, mode);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 进入对应页面
  if (mode === 'chat') {
    await clickText(page, '聊一聊');
  } else if (mode === 'roleplay') {
    await clickText(page, '剧情演绎');
  } else if (mode === 'wenyou') {
    await clickText(page, '剧情演绎');
    await clickText(page, 'AI 文游');
  }
  // home：不导航

  const expected = EXPECT[mode];
  const got = [];
  const results = [];
  for (let i = 0; i < expected.length; i++) {
    const ok = await waitBubble(page, expected[i]);
    got.push(ok ? expected[i] : '<<MISMATCH>> ' + (await readBubble(page)));
    await sleep(400); // 等 scrollIntoView / 轮询贴合目标
    const shot = `${OUT}/${mode}_step${i + 1}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    results.push({ step: i + 1, expected: expected[i], ok, shot });
    if (i < expected.length - 1) await clickAdvance(page);
  }
  // 最后一步：主按钮应为「开始聊聊」（coachDone），且没有「下一个」
  const lastIsDone = await page.evaluate(() => {
    const txts = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
    return txts.includes('开始聊聊') && !txts.includes('下一个');
  });
  await page.close();
  const allOk = got.every((g, i) => g === expected[i]) && lastIsDone;
  return { mode, results, lastIsDone, got, allOk, consoleErrors: cons };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=390,844'],
});

const out = [];
for (const mode of ['chat', 'home', 'roleplay', 'wenyou']) {
  try {
    const r = await runPage(browser, mode);
    out.push(r);
    console.log(`[${mode}] order=${r.allOk ? 'PASS' : 'FAIL'} lastIsDone=${r.lastIsDone} errors=${r.consoleErrors.length}`);
    console.log('   steps:', r.got.map((g, i) => `${i + 1}.${g.slice(0, 18)}`).join(' | '));
    if (r.consoleErrors.length) console.log('   consoleErrors:', r.consoleErrors.join(' || '));
  } catch (e) {
    console.log(`[${mode}] EXCEPTION: ${e.message}`);
  }
}
await browser.close();

const pass = out.filter((r) => r.allOk && r.lastIsDone && r.consoleErrors.length === 0).length;
console.log(`\nRESULT: ${pass}/4 pages ordered-as-expected`);
console.log('SAVED screenshots under', OUT);
