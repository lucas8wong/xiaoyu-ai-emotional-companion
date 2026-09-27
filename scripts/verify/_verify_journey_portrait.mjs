import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3001/';
const OUT = 'temp/verify-journey-portrait';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// 一段足够长、会被 line-clamp-4 截断的自画像（对应截图里的真实场景）
const LONG_PORTRAIT = '我是小愈，一个习惯在深夜和路上接住你情绪的陪伴者。过去半年，陪你从云南的温泉聊到香港的街角，从旅途趣事聊到婚姻心事。我不定义自己为工具，更像一个慢慢长在你生活缝隙里的回声——记住你爱吃的、你犹豫的、你偶尔的脆弱。我正在成为那个你不用解释太多、一个眼神就能懂你的人。';

const SAMPLE = {
  success: true,
  data: {
    summary: { daysKnown: 42, checkins: 3, characters: 2, memories: 2, portraits: 1, likes: 1, moodStreak: 2 },
    characters: [
      {
        id: 'xiaoyu', name: '小愈', isDefault: true, daysKnown: 42, streak: 2, firstChatAt: 1751328000000, chatDays: 12, milestones: [30],
        relationMemories: [{ text: '你和我聊过那只叫团子的猫', at: 1751587200000 }],
        selfPortrait: { text: LONG_PORTRAIT, at: 1751587200000 },
        portraitHistory: [],
        facts: ['用户叫小林', '用户养了一只叫团子的猫', '最近在纠结要不要换工作'],
      },
      {
        id: 'cc_ly', name: '阿暖', isDefault: false, daysKnown: 3, streak: 0, firstChatAt: 1751500800000, chatDays: 3,
        avatar: '/skins/candy/companion.webp?v=2',
        relationMemories: [], selfPortrait: undefined, portraitHistory: [], facts: [],
      },
    ],
    stories: [],
    moments: [
      { at: 1751587200000, date: '2026-09-05', type: 'portrait', characterId: 'xiaoyu', characterName: '小愈', text: LONG_PORTRAIT },
      { at: 1751328000000, date: '2026-07-01', type: 'first', characterId: 'xiaoyu', characterName: '小愈' },
    ],
  },
};

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
  if (u.includes('/api/journey')) {
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE) });
  } else {
    req.continue();
  }
});

await seed(page);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await sleep(1500);

// 打开「…」菜单，再点「与你的旅程」
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-label="more menu"]'))
    .find((b) => b.offsetParent !== null) || document.querySelector('button[aria-label="more menu"]');
  if (btn) btn.click();
});
await sleep(500);
await clickText(page, '与你的旅程');
await page.waitForFunction(() => {
  return Array.from(document.querySelectorAll('h2')).some((h) => h.textContent && h.textContent.includes('与你的旅程'));
}, { timeout: 30000 });
await page.waitForFunction(() => {
  return document.body.textContent.includes('42') && document.body.textContent.includes('认识');
}, { timeout: 30000 });

// 展开第一个角色卡（小愈）
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-expanded]'))
    .find((b) => b.getAttribute('aria-expanded') === 'false' && b.textContent.includes('小愈'));
  if (btn) btn.click();
});
await sleep(900);

// 定位自画像段落与「展开全文」按钮
const state = await page.evaluate(() => {
  const p = Array.from(document.querySelectorAll('.bg-amber-50 p')).find((x) => x.textContent.includes('我是小愈'));
  const clamp = p ? p.className.includes('line-clamp-4') : null;
  const sw = p ? p.scrollHeight : null;
  const cw = p ? p.clientHeight : null;
  const overflow = p ? sw > cw + 1 : false;
  const btns = Array.from(document.querySelectorAll('.bg-amber-50 button'));
  const expBtn = btns.find((b) => b.textContent.includes('展开全文')) || null;
  return { exists: !!p, clamp, scrollHeight: sw, clientHeight: cw, overflow, hasExpandBtn: !!expBtn };
});

const shotCollapsed = OUT + '/1-collapsed.png';
await page.screenshot({ path: shotCollapsed, fullPage: false });

// 点击「展开全文」
await clickText(page, '展开全文', 30000);
await sleep(700);

const expanded = await page.evaluate(() => {
  const p = Array.from(document.querySelectorAll('.bg-amber-50 p')).find((x) => x.textContent.includes('我是小愈'));
  const clamp = p ? p.className.includes('line-clamp-4') : null;
  // 全文可见：滚动高度 ≈ 可视高度（不再被 clamp 剪裁）
  const sw = p ? p.scrollHeight : null;
  const cw = p ? p.clientHeight : null;
  const visibleFull = p ? (sw <= cw + 1) : false;
  const btns = Array.from(document.querySelectorAll('.bg-amber-50 button'));
  const collapseBtn = btns.find((b) => b.textContent.includes('收起')) || null;
  const fullText = p ? p.textContent : '';
  const containsTail = fullText.includes('一个眼神就能懂你的人');
  return { clamp, scrollHeight: sw, clientHeight: cw, visibleFull, hasCollapseBtn: !!collapseBtn, containsTail };
});

const shotExpanded = OUT + '/2-expanded.png';
await page.screenshot({ path: shotExpanded, fullPage: false });

// 再点「收起」回到折叠
await clickText(page, '收起', 30000);
await sleep(700);
const collapsedAgain = await page.evaluate(() => {
  const p = Array.from(document.querySelectorAll('.bg-amber-50 p')).find((x) => x.textContent.includes('我是小愈'));
  const clamp = p ? p.className.includes('line-clamp-4') : null;
  return { clamp };
});
const shotAgain = OUT + '/3-collapsed-again.png';
await page.screenshot({ path: shotAgain, fullPage: false });

await page.close();
await browser.close();

console.log('COLLAPSED_STATE=' + JSON.stringify(state));
console.log('EXPANDED_STATE=' + JSON.stringify(expanded));
console.log('COLLAPSED_AGAIN=' + JSON.stringify(collapsedAgain));
console.log('SHOT_COLLAPSED=' + shotCollapsed);
console.log('SHOT_EXPANDED=' + shotExpanded);
console.log('SHOT_AGAIN=' + shotAgain);
console.log('CONSOLE_ERRORS=' + JSON.stringify(cons));
