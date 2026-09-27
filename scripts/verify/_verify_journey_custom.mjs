/**
 * 「与你的旅程」自建剧情显示 —— 实机验证（mock /api/journey）
 *
 * 需求：AI 创建／用户自建的剧情，在「与你的旅程」里**必须显示用户自己起的剧名 + 一个「自建」标志**，
 * 不再出现「自定义剧情」占位，也绝不出现 custom_xxx 内部 id。
 *
 * 断言：4 条剧情足迹（自建角色扮演 / 自建文游 / 官方 / 解析不到真名的自建）
 *  + 「自建」标志只挂自建的、不挂官方的
 *  + 全文无「自定义剧情」、无 custom_ / custom- 内部 id
 *  + 0 console error，并截图供人工视觉复核
 *
 * 用法：node scripts/verify/_verify_journey_custom.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://127.0.0.1:3001/';
const OUT = 'temp/verify-journey-custom';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const T = 1751600000000;
const SAMPLE = {
  success: true,
  data: {
    summary: { daysKnown: 12, checkins: 1, characters: 1, memories: 1, portraits: 0, likes: 1, moodStreak: 1 },
    characters: [
      {
        id: 'xiaoyu', name: '小愈', isDefault: true, daysKnown: 12, streak: 1, firstChatAt: T - 86400000,
        chatDays: 1, milestones: [], relationMemories: [], portraitHistory: [], facts: [],
      },
    ],
    stories: [
      // 自建角色扮演（用户起的剧名）
      { scenarioId: 'custom_mta04dcft8re28', title: '虚空一脈', at: T, kind: 'roleplay', custom: true },
      // 自建千世书（连字符前缀那套）
      { scenarioId: 'custom-mine', title: '我的江湖', at: T - 1000, kind: 'wenyou', custom: true },
      // 官方剧本：不该有「自建」标志
      { scenarioId: 's2', title: '替姐出嫁那夜', at: T - 2000, kind: 'roleplay' },
      // 剧本已被删除、连快照都没有 → 前端兜底文案 + 「已删」标志（不是「自定义剧情」，也不是内部 id）
      { scenarioId: 'custom_mt3o842ia2bcg2', title: '', at: T - 3000, kind: 'roleplay', custom: true, deleted: true },
    ],
    moments: [
      { at: T, date: '2026-09-17', type: 'like', characterId: '', characterName: '', text: '虚空一脈', custom: true },
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
  await page.waitForFunction((q) => Array.from(document.querySelectorAll('button, a'))
    .some((b) => b.textContent && b.textContent.indexOf(q) !== -1), { timeout }, text);
  await page.evaluate((q) => {
    const els = Array.from(document.querySelectorAll('button, a'))
      .filter((b) => b.textContent && b.textContent.indexOf(q) !== -1);
    if (els.length) els[els.length - 1].click();
  }, text);
}

const failures = [];
const check = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { failures.push(msg); console.log('  ❌ ' + msg); } };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=390,844'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
const cons = [];
page.on('console', (m) => { if (m.type() === 'error') cons.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => cons.push('PAGEERROR: ' + String(e).slice(0, 200)));

await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().includes('/api/journey')) {
    req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE) });
  } else { req.continue(); }
});

await seed(page);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await sleep(1500);
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-label="more menu"]'))
    .find((b) => b.offsetParent !== null) || document.querySelector('button[aria-label="more menu"]');
  if (btn) btn.click();
});
await sleep(500);
await clickText(page, '与你的旅程');
await page.waitForFunction(() => Array.from(document.querySelectorAll('h2'))
  .some((h) => h.textContent && h.textContent.includes('与你的旅程')), { timeout: 30000 });
await sleep(1200);

// —— 收集「你去过的剧情」那一块的每枚 chip ——
const info = await page.evaluate(() => {
  const h3 = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent.includes('你去过的剧情'));
  const card = h3 ? h3.parentElement : null;
  const chips = card ? Array.from(card.querySelectorAll('span')).filter((s) => /rounded-full/.test(s.className)) : [];
  const rows = chips.map((c) => ({
    text: (c.textContent || '').trim(),
    tags: Array.from(c.querySelectorAll('span')).map((s) => (s.textContent || '').trim()),
  }));
  return {
    rows,
    bodyText: (card ? card.textContent : document.body.textContent) || '',
    fullBody: document.body.textContent || '',
  };
});

console.log('chip 明细：'); info.rows.forEach((r) => console.log('   · ' + JSON.stringify(r.tags)));

const rowOf = (name) => info.rows.find((r) => r.text.includes(name));
check(!!rowOf('虚空一脈'), '自建角色扮演显示用户起的剧名「虚空一脈」');
check(!!rowOf('我的江湖'), '自建千世书（custom- 前缀）显示剧名「我的江湖」');
check(!!rowOf('替姐出嫁那夜'), '官方剧本照常显示');
check(!!rowOf('自建剧情'), '解析不到真名的自建 → 兜底「自建剧情」（不给内部 id）');

check(!!rowOf('虚空一脈')?.tags.includes('自建'), '「虚空一脈」挂「自建」标志');
check(!!rowOf('我的江湖')?.tags.includes('自建') && !!rowOf('我的江湖')?.tags.includes('文游'), '「我的江湖」同时有「文游」「自建」两个标志');
check(!(rowOf('替姐出嫁那夜')?.tags || []).includes('自建'), '官方剧本**不**挂「自建」标志');
check(!(rowOf('自建剧情')?.tags || []).includes('自建'), '兜底文案本身已含「自建」，不重复挂标志');
check(!!rowOf('自建剧情')?.tags.includes('已删'), '剧本被删 → 兜底「自建剧情」旁挂「已删」（用户口径：要看得出来是已删的）');
check(!(rowOf('虚空一脈')?.tags || []).includes('已删'), '剧本还在的自建剧情不挂「已删」');
check(!info.bodyText.includes('自定义剧情'), '「你去过的剧情」里没有「自定义剧情」字样');
check(!/custom[_-][a-z0-9]/i.test(info.bodyText), '没有任何 custom_xxx / custom-xxx 内部 id 露出');
check(!info.fullBody.includes('自定义剧情'), '整个旅程弹窗里没有「自定义剧情」字样');

// —— 截图（供 read_image 人工复核）——
const cardEl = await page.evaluateHandle(() => {
  const h3 = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent.includes('你去过的剧情'));
  return h3 ? h3.parentElement : document.body;
});
await cardEl.asElement().screenshot({ path: OUT + '/1-stories-card.png' });
await page.screenshot({ path: OUT + '/2-journey-full.png' });
check(cons.length === 0, '0 console error（实际 ' + cons.length + '：' + cons.slice(0, 3).join(' | ') + '）');

await browser.close();
console.log(failures.length === 0 ? '\n✅ PASS：与你的旅程自建剧情显示口径全部通过' : `\n❌ FAIL ${failures.length} 项：\n - ` + failures.join('\n - '));
process.exit(failures.length === 0 ? 0 : 1);
