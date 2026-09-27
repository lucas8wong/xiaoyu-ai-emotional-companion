import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3001/';
const OUT = 'temp/verify-journey';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// 用样本数据桩替身，验证「有数据」时的时间线渲染（不污染真实数据）
const SAMPLE = {
  success: true,
  data: {
    summary: { daysKnown: 42, checkins: 3, characters: 2, memories: 2, portraits: 1, likes: 1, moodStreak: 2 },
    characters: [
      {
        id: 'xiaoyu', name: '小愈', isDefault: true, daysKnown: 42, streak: 2, firstChatAt: 1751328000000, chatDays: 12, milestones: [30],
        relationMemories: [{ text: '你和我聊过那只叫团子的猫', at: 1751587200000 }],
        selfPortrait: { text: '在 TA 眼里，你是一个很温柔的人，也有一点倔强。', at: 1751587200000 },
        portraitHistory: [],
        facts: ['用户叫小林', '用户养了一只叫团子的猫', '最近在纠结要不要换工作'],
      },
      {
        id: 'cc_ly', name: '阿暖', isDefault: false, daysKnown: 3, streak: 0, firstChatAt: 1751500800000, chatDays: 3,
        avatar: '/skins/candy/companion.webp?v=2',
        relationMemories: [], selfPortrait: undefined, portraitHistory: [], facts: [],
      },
    ],
    stories: [
      { scenarioId: 's1', title: '雨夜捡到的他会暖床', at: 1751500800000 },
      { scenarioId: 'xian', title: '缥缈仙途', at: 1751600000000, kind: 'wenyou' },
    ],
    moments: [
      { at: 1752100000000, date: '2026-09-07', type: 'like', characterId: '', characterName: '', text: '雨夜捡到的他会暖床' },
      { at: 1752000000000, date: '2026-09-06', type: 'mood', characterId: '', characterName: '', mood: 'grateful', note: '今天被人暖到了' },
      { at: 1751587200000, date: '2026-09-05', type: 'portrait', characterId: 'xiaoyu', characterName: '小愈', text: '在 TA 眼里，你是一个很温柔的人，也有一点倔强。' },
      { at: 1751500800000, date: '2026-09-04', type: 'memory', characterId: 'xiaoyu', characterName: '小愈', text: '你和我聊过那只叫团子的猫' },
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
const homeShot = OUT + '/home.png';
await page.screenshot({ path: homeShot, fullPage: false });

// 打开「…」菜单，再点「与你的旅程」
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-label="more menu"]'))
    .find((b) => b.offsetParent !== null) || document.querySelector('button[aria-label="more menu"]');
  if (btn) btn.click();
});
await sleep(500);
await clickText(page, '与你的旅程');
// 等待旅程弹窗标题出现
await page.waitForFunction(() => {
  return Array.from(document.querySelectorAll('h2')).some((h) => h.textContent && h.textContent.includes('与你的旅程'));
}, { timeout: 30000 });

// 等有内容渲染（认识 42 天 摘要 chip）
await page.waitForFunction(() => {
  return document.body.textContent.includes('42') && document.body.textContent.includes('认识');
}, { timeout: 30000 });

// 展开第一个角色卡（小愈），显示结构化分区内容
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button[aria-expanded]'))
    .find((b) => b.getAttribute('aria-expanded') === 'false' && b.textContent.includes('小愈'));
  if (btn) btn.click();
});
await sleep(800);
const shot = OUT + '/journey.png';
await page.screenshot({ path: shot, fullPage: false });

// 滚动到「足迹印章」附近，确认展开后的结构化分区
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('h4')).find((h) => h.textContent.includes('足迹印章'));
  if (el) el.scrollIntoView({ block: 'start' });
});
await sleep(500);
const shotCard = OUT + '/journey-card.png';
await page.screenshot({ path: shotCard, fullPage: false });

// 滚动到时间线「我们的瞬间」再截一张（确认 moments 渲染）
await page.evaluate(() => {
  const el = document.querySelector('.flex-1.overflow-y-auto');
  if (el) el.scrollTo(0, el.scrollHeight);
});
await sleep(600);
const shot2 = OUT + '/journey-timeline.png';
await page.screenshot({ path: shot2, fullPage: false });

const summary = await page.evaluate(() => {
  return {
    title: Array.from(document.querySelectorAll('h2')).find((h) => h.textContent.includes('与你的旅程'))?.textContent || '',
    hasDaysKnown: document.body.textContent.includes('认识 42 天'),
    hasMoodStreak: document.body.textContent.includes('心情连续 2 天'),
    hasMood: document.body.textContent.includes('被人暖到'),
    hasLike: document.body.textContent.includes('雨夜捡到的他会暖床'),
    hasPortrait: document.body.textContent.includes('在 TA 眼里'),
    hasFirst: document.body.textContent.includes('初次相遇'),
    hasMoodTrend: document.body.textContent.includes('心情趋势'),
    hasStamps: document.body.textContent.includes('足迹印章') && document.body.textContent.includes('聊到 30 轮'),
    hasStories: document.body.textContent.includes('你去过的剧情') && document.body.textContent.includes('雨夜捡到的他会暖床'),
    hasWithThem: document.body.textContent.includes('与 TA 的瞬间'),
    hasWenyou: document.body.textContent.includes('文游') && document.body.textContent.includes('缥缈仙途'),
    hasStructuredSections: document.body.textContent.includes('足迹印章') && document.body.textContent.includes('TA 的自画像') && document.body.textContent.includes('TA 记得的关于你') && document.body.textContent.includes('你们之间'),
  };
});

await page.close();
await browser.close();

console.log('SHOT=' + shot);
console.log('SHOT_CARD=' + (typeof shotCard !== 'undefined' ? shotCard : ''));
console.log('SUMMARY=' + JSON.stringify(summary));
console.log('CONSOLE_ERRORS=' + JSON.stringify(cons));
