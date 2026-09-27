import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:3001/';
const OUT = 'temp/verify-nav-journey';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// 空旅程数据：导致 JourneyModal 进入空态（无瞬间/剧情/角色）
const EMPTY_JOURNEY = {
  success: true,
  data: {
    summary: { daysKnown: 0, checkins: 0, characters: 0, memories: 0, likes: 0, moodStreak: 0 },
    characters: [],
    stories: [],
    moments: [],
  },
};

function seed(page, opts) {
  return page.evaluateOnNewDocument((o) => {
    const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
    set('cure_lang', 'zh-CN');
    set('cure_privacy_agreed', '1');
    set('cure_guide_seen', '1');
    set('cure_reg_prompted', '1');
    set('cure_guest_prompted', '1');
    set('cure_rp_coach_seen', '1');
    set('cure_rp_intro_seen', '1');
    set('cure_wy_coach_seen', '1');
    set('cure_chat_coach_seen', '1');
    // 分场景差异
    set('cure_ui_tour_seen', o.uiTourSeen ? '1' : '0');   // A：不 seen → 显示导览条；B：seen → 隐藏导览
    set('cure_home_coach_seen', o.homeCoachSeen ? '1' : '0'); // B：不 seen → 显示首页功能引导气泡
  }, opts);
}

async function clickByText(page, text, timeout = 30000) {
  await page.waitForFunction((q) => {
    return Array.from(document.querySelectorAll('button, a'))
      .some((b) => b.textContent && b.textContent.includes(q));
  }, { timeout }, text);
  await page.evaluate((q) => {
    const els = Array.from(document.querySelectorAll('button, a'))
      .filter((b) => b.textContent && b.textContent.includes(q));
    if (els.length) els[els.length - 1].click();
  }, text);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=390,844'],
});
const results = {};

// ---------- 场景 A：新用户导览含「与你的旅程」→ 点入旅程空态三按钮 ----------
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const cons = [];
  page.on('console', (m) => { if (m.type() === 'error') cons.push(m.text()); });
  page.on('pageerror', (e) => cons.push('PAGEERROR: ' + String(e)));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/journey')) {
      req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_JOURNEY) });
    } else {
      req.continue();
    }
  });
  await seed(page, { uiTourSeen: false, homeCoachSeen: true });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(1600);

  // 顶栏新用户导览提示条出现
  const barShown = await page.evaluate(() => document.body.textContent.includes('新来的？'));
  await clickByText(page, '查看导览');
  await page.waitForFunction(() => document.body.textContent.includes('在小愈里能找到什么'), { timeout: 30000 });
  await sleep(800);

  const tour = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.textContent.includes('与你的旅程'));
    return { journeyItem: btns.length > 0, journeyLabel: btns[0]?.textContent?.replace(/\s+/g, ' ') || '' };
  });
  await page.screenshot({ path: OUT + '/A1-tour-with-journey.png', fullPage: false });

  // 点「与你的旅程」→ 打开旅程弹窗（空态）
  await clickByText(page, '与你的旅程');
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('h2')).some((h) => h.textContent && h.textContent.includes('与你的旅程'));
  }, { timeout: 40000 });
  await sleep(1200);

  const journey = await page.evaluate(() => {
    const h2 = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent.includes('与你的旅程'));
    const modalRoot = h2 ? h2.closest('div.fixed') : null;
    const bodyText = modalRoot ? modalRoot.textContent : document.body.textContent;
    const btnTexts = modalRoot
      ? Array.from(modalRoot.querySelectorAll('button')).map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim())
      : [];
    return {
      empty: bodyText.includes('你们的旅程还没有开始'),
      hasChat: btnTexts.some((x) => x.includes('聊一聊')),
      hasStructure: btnTexts.some((x) => x.includes('理一理')),
      hasRoleplay: btnTexts.some((x) => x.includes('剧情演绎') || x.includes('剧情扮演')),
      btnTexts,
    };
  });
  await page.screenshot({ path: OUT + '/A2-journey-empty-3buttons.png', fullPage: false });

  // 点「聊一聊」直达 → 应关掉旅程并进入聊一聊
  await clickByText(page, '聊一聊');
  await sleep(1000);
  const afterClick = await page.evaluate(() => ({
    journeyGone: !Array.from(document.querySelectorAll('h2')).some((h) => h.textContent && h.textContent.includes('与你的旅程')),
    chatOpen: document.body.textContent.includes('聊一聊') || document.body.textContent.includes('想到哪说到哪就好'),
  }));

  results.tour = { barShown, ...tour };
  results.journeyEmpty = journey;
  results.afterChatClick = afterClick;
  results.consoleErrorsA = cons;
  await page.close();
}

// ---------- 场景 B：首页功能引导气泡（⋯ 步骤）文案包含「与你的旅程」 ----------
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const cons = [];
  page.on('console', (m) => { if (m.type() === 'error') cons.push(m.text()); });
  page.on('pageerror', (e) => cons.push('PAGEERROR: ' + String(e)));
  await seed(page, { uiTourSeen: true, homeCoachSeen: false });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(1800);

  const coach = await page.evaluate(() => {
    const bubble = Array.from(document.querySelectorAll('div')).find((d) =>
      d.className && /fixed/.test(d.className) && d.textContent.includes('都收在这里'));
    // 更稳：直接看整个 body 里是否出现第一步气泡文本
    const firstBubbleText = bubble ? bubble.textContent.replace(/\s+/g, ' ').trim() : '';
    return {
      text: firstBubbleText,
      hasJourney: firstBubbleText.includes('与你的旅程'),
      hasMoreMenu: firstBubbleText.includes('我的记录'),
    };
  });
  await page.screenshot({ path: OUT + '/B1-home-coach-more-journey.png', fullPage: false });

  results.homeCoach = coach;
  results.consoleErrorsB = cons;
  await page.close();
}

await browser.close();

console.log('RESULT=' + JSON.stringify(results, null, 2));
