/**
 * 截取首页作为 smoke 截图（交付证据用）。
 * 用法：node scripts/verify-home.mjs
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

fs.mkdirSync('temp/verify-recall', { recursive: true });
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });
await page.goto('http://127.0.0.1:3001/', { waitUntil: 'networkidle2' });
await page.evaluate(() => {
  localStorage.setItem('cure_home_coach_seen', '1');
  localStorage.setItem('cure_ui_tour_seen', '1');
});
await page.goto('http://127.0.0.1:3001/', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: 'temp/verify-recall/home.png' });
await browser.close();
console.log('home screenshot saved');
