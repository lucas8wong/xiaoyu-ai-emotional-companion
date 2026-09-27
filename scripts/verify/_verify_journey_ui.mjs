import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3001/';
const OUT = 'temp/verify-journey-ui';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const LONG_PORTRAIT = '我是小愈，一个习惯在深夜和路上接住你情绪的陪伴者。过去半年，陪你从云南的温泉聊到香港的街角，从旅途趣事聊到婚姻心事。我不定义自己为工具，更像一个慢慢长在你生活缝隙里的回声——记住你爱吃的、你犹豫的、你偶尔的脆弱。我正在成为那个你不用解释太多、一个眼神就能懂你的人。';

const REL_MEM = [
  '你和我聊过那只叫团子的猫',
  '你最近在纠结要不要换工作',
  '你很喜欢下雨天窝在家里',
  '你提到过小时候在老家的小河游泳',
  '你习惯把心事写在夜晚',
  '你三次去过那家街角的奶茶店',
  '你有一句口头禅是「算了」',
  '你会在深夜给我发长长的语音',
];

const STORIES = [
  { id: 's1', title: '雨夜捡到的他会暖床' },
  { id: 's2', title: '替姐出嫁那夜' },
  { id: 'xian', title: '缥缈仙途', kind: 'wenyou' },
  { id: 's4', title: '被青梅竹马反撩以后' },
  { id: 's5', title: '快穿之拯救恋爱脑反派' },
  { id: 's6', title: '厂公是个白切黑' },
  { id: 'custom_mtqy8099ib3dmt', title: 'custom_mtqy8099ib3dmt' }, // 未解析的自建剧本 → 前端显示占位
  { id: 's8', title: '我的师父是条龙' },
];

const SAMPLE = {
  success: true,
  data: {
    summary: { daysKnown: 42, checkins: 3, characters: 1, memories: 8, portraits: 1, likes: 1, moodStreak: 2 },
    characters: [
      {
        id: 'xiaoyu', name: '小愈', isDefault: true, daysKnown: 42, streak: 2, firstChatAt: 1751328000000, chatDays: 12, milestones: [30, 100],
        relationMemories: REL_MEM.map((text, i) => ({ text, at: 1751587200000 - i * 86400000 })),
        selfPortrait: { text: LONG_PORTRAIT, at: 1751587200000 },
        portraitHistory: [],
        facts: ['用户叫小林', '用户养了一只叫团子的猫', '最近在纠结要不要换工作'],
      },
    ],
    stories: STORIES.map((s, i) => ({ scenarioId: s.id, title: s.title, at: 1751600000000 - i * 86400000, kind: s.kind || 'roleplay' })),
    moments: [
      { at: 1752100000000, date: '2026-09-07', type: 'like', characterId: '', characterName: '', text: '雨夜捡到的他会暖床' },
      { at: 1752000000000, date: '2026-09-06', type: 'mood', characterId: '', characterName: '', mood: 'grateful', note: '今天被人暖到了' },
      { at: 1751587200000, date: '2026-09-05', type: 'portrait', characterId: 'xiaoyu', characterName: '小愈', text: LONG_PORTRAIT },
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

// —— 断言 1：你们之间 + TA 记得的关于你 用统一的 skin 色小圆点 ——
const relCheck = await page.evaluate(() => {
  const relSection = Array.from(document.querySelectorAll('h4')).find((h) => h.textContent.includes('你们之间'))?.parentElement;
  const factSection = Array.from(document.querySelectorAll('h4')).find((h) => h.textContent.includes('TA 记得的关于你'))?.parentElement;
  const bulletsOf = (sec) => (sec ? Array.from(sec.querySelectorAll('li')) : []);
  const relLis = bulletsOf(relSection);
  const factLis = bulletsOf(factSection);
  const dotCls = (li) => li.querySelector('span.rounded-full.bg-primary')?.className || '';
  const relDotsOk = relLis.length > 0 && relLis.every((li) => /w-1 h-1 rounded-full bg-primary/.test(dotCls(li)));
  const factDotsOk = factLis.length > 0 && factLis.every((li) => /w-1 h-1 rounded-full bg-primary/.test(dotCls(li)));
  const same = relDotsOk && factDotsOk; // 两处同尺寸同色
  const noOldChip = relLis.length > 0 && relLis.every((li) => !li.className.includes('bg-primary-lighter'));
  return {
    relCount: relLis.length, factCount: factLis.length,
    relDotsOk, factDotsOk, same, noOldChip,
    relFirst: relLis[0]?.textContent || '', factFirst: factLis[0]?.textContent || '',
  };
});

const shotCard = OUT + '/1-card.png';
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('h4')).find((h) => h.textContent.includes('TA 记得的关于你'));
  el?.scrollIntoView({ block: 'start' });
});
await sleep(500);
await page.screenshot({ path: shotCard, fullPage: false });

// —— 时间线「与 TA 的瞬间」——
const shotTimeline = OUT + '/1b-timeline.png';
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('h4')).find((h) => h.textContent.includes('与 TA 的瞬间'));
  el?.scrollIntoView({ block: 'start' });
});
await sleep(500);
await page.screenshot({ path: shotTimeline, fullPage: false });

// —— 断言 2：自画像展开全文 ——
await clickText(page, '展开全文', 30000);
await sleep(700);
const portrait = await page.evaluate(() => {
  const p = Array.from(document.querySelectorAll('.bg-amber-50 p')).find((x) => x.textContent.includes('我是小愈'));
  return { full: p ? (p.scrollHeight <= p.clientHeight + 1) : false, tail: p ? p.textContent.includes('一个眼神就能懂你的人') : false };
});
const shotPortrait = OUT + '/2-portrait-expanded.png';
await page.screenshot({ path: shotPortrait, fullPage: false });

// —— 断言 3：你去过的剧情折叠 + 自建占位 ——
const storyState = await page.evaluate(() => {
  const sec = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent.includes('你去过的剧情'))?.parentElement;
  const chips = sec ? Array.from(sec.querySelectorAll('span.rounded-full')) : [];
  const titles = chips.map((c) => c.textContent);
  const hasCustomId = titles.some((x) => x.includes('custom_mtqy8099ib3dmt'));
  const hasPlaceholder = titles.some((x) => x.includes('自定义剧情'));
  const moreBtn = sec ? Array.from(sec.querySelectorAll('button')).find((b) => b.textContent.includes('更多')) : null;
  return { chipCount: chips.length, hasCustomId, hasPlaceholder, hasMoreBtn: !!moreBtn, moreLabel: moreBtn ? moreBtn.textContent : '' };
});
const shotStories = OUT + '/3-stories-folded.png';
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent.includes('你去过的剧情'));
  el?.scrollIntoView({ block: 'start' });
});
await sleep(500);
await page.screenshot({ path: shotStories, fullPage: false });

// 点击「更多」展开全部剧情（限定在「你去过的剧情」分区，避免点到时刻/回忆的「更多」）
await page.evaluate(() => {
  const sec = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent.includes('你去过的剧情'))?.parentElement;
  const btn = sec && Array.from(sec.querySelectorAll('button')).find((b) => b.textContent.includes('更多'));
  if (btn) btn.click();
});
await sleep(700);
const storyExpanded = await page.evaluate(() => {
  const sec = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent.includes('你去过的剧情'))?.parentElement;
  const chips = sec ? Array.from(sec.querySelectorAll('span.rounded-full')) : [];
  const titles = chips.map((c) => c.textContent);
  const hasPlaceholder = titles.some((x) => x.includes('自定义剧情'));
  return { chipCount: chips.length, hasPlaceholder };
});
const shotStoriesExpanded = OUT + '/4-stories-expanded.png';
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent.includes('你去过的剧情'));
  el?.scrollIntoView({ block: 'start' });
});
await sleep(500);
await page.screenshot({ path: shotStoriesExpanded, fullPage: false });

await page.close();
await browser.close();

console.log('REL=' + JSON.stringify(relCheck));
console.log('PORTRAIT=' + JSON.stringify(portrait));
console.log('STORY_FOLDED=' + JSON.stringify(storyState));
console.log('STORY_EXPANDED=' + JSON.stringify(storyExpanded));
console.log('SHOT_CARD=' + shotCard);
console.log('SHOT_PORTRAIT=' + shotPortrait);
console.log('SHOT_STORIES=' + shotStories);
console.log('SHOT_STORIES_EXPANDED=' + shotStoriesExpanded);
console.log('CONSOLE_ERRORS=' + JSON.stringify(cons));
