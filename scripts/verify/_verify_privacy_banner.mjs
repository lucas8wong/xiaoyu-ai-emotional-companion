import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://localhost:5173/';
const OUT = 'temp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 新用户、未同意隐私、且聊一聊 coach 未看过（保留气泡导航）
function seedStorage(page) {
  return page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('cure_lang', 'zh-CN');
      localStorage.removeItem('cure_privacy_agreed'); // 未同意 → 底部隐私横幅可见
      localStorage.setItem('cure_guide_seen', '1');
      localStorage.setItem('cure_ui_tour_seen', '1');
      localStorage.setItem('cure_home_coach_seen', '1');
      localStorage.setItem('cure_reg_prompted', '1');
      localStorage.setItem('cure_guest_prompted', '1');
      localStorage.removeItem('cure_chat_coach_seen'); // 触发聊一聊 coach
    } catch (e) { /* ignore */ }
  });
}

async function clickChat(page) {
  const sel = () => Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent && b.textContent.includes('聊一聊') && b.className.includes('card-white'));
  await page.waitForFunction(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((btn) => btn.textContent && btn.textContent.includes('聊一聊') && btn.className.includes('card-white'));
    return !!b;
  }, { timeout: 30000 });
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((btn) => btn.textContent && btn.textContent.includes('聊一聊') && btn.className.includes('card-white'));
    if (b) b.click();
  });
  return sel;
}

async function waitCoachNext(page) {
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('button'))
      .some((b) => b.textContent && b.textContent.trim() === '下一个');
  }, { timeout: 30000 });
}

async function clickCoachNext(page) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((btn) => btn.textContent && btn.textContent.trim() === '下一个');
    if (b) b.click();
  });
}

async function dismissCoach(page) {
  // 「跳过，开始聊聊」链接：结束气泡导航（去掉暗色遮罩）
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((btn) => btn.textContent && btn.textContent.includes('跳过，开始聊聊'));
    if (b) b.click();
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
});

// ---------- 桌面 1280x800 ----------
const d = await browser.newPage();
await d.setViewport({ width: 1280, height: 800 });
await seedStorage(d);
await d.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await clickChat(d);
await waitCoachNext(d);
await sleep(500);
// 前进两步：role → history → image（加号/发送，位于底部输入栏）
await clickCoachNext(d);
await sleep(900);
await clickCoachNext(d);
await sleep(1100); // coach 250ms 轮询重测，等它贴合新目标
await d.screenshot({ path: `${OUT}/privacy_banner_coach_image_desktop.png`, fullPage: false });

// 跳过引导 → 无遮罩下看「输入栏在隐私横幅之上」的关系
await dismissCoach(d);
await sleep(800);
await d.screenshot({ path: `${OUT}/privacy_banner_nowcoach_desktop.png`, fullPage: false });

// 点「同意并继续」→ 横幅卸载 → 输入栏回落到底部（空间回收）
await d.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button'))
    .find((btn) => btn.textContent && btn.textContent.includes('同意并继续'));
  if (b) b.click();
});
await sleep(900);
await d.screenshot({ path: `${OUT}/privacy_banner_after_agree_desktop.png`, fullPage: false });
await d.close();

// ---------- 移动 390x844 ----------
const m = await browser.newPage();
await m.setViewport({ width: 390, height: 844 });
await seedStorage(m);
await m.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await clickChat(m);
await waitCoachNext(m);
await sleep(500);
await clickCoachNext(m);
await sleep(900);
await clickCoachNext(m);
await sleep(1100);
await m.screenshot({ path: `${OUT}/privacy_banner_coach_image_mobile.png`, fullPage: false });
await m.close();

await browser.close();
console.log('SAVED:', [
  'temp/privacy_banner_coach_image_desktop.png',
  'temp/privacy_banner_nowcoach_desktop.png',
  'temp/privacy_banner_after_agree_desktop.png',
  'temp/privacy_banner_coach_image_mobile.png',
].join(', '));
