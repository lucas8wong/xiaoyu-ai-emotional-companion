/**
 * 预渲染脚本（SEO）：vite build 之后运行，把公开内容页快照成静态 HTML，
 * 让不执行 JS 的爬虫（ChatGPT / Perplexity / Google AI / 微信 / 小红书等）直接看到正文内容，
 * 而不是 SPA 空壳。
 *
 * 覆盖路由：
 *   /                    首页（「已同意隐私」上下文，快照到品牌正文）
 *   /faq                 FAQ 公开页（15 问 + FAQPage JSON-LD）
 *   /s/<id>[/-<i>]/      千世书分享入口页（全部内置剧本 × 各开局，扫码/社交链接落点）
 *
 * 用法：
 *   npm run build:seo     # vite build && tsx scripts/prerender.mts
 *   tsx scripts/prerender.mts   # 单独运行（需先 build 过）
 *   PRERENDER_BASE_URL=http://127.0.0.1:3001 tsx scripts/prerender.mts  # 直连已有服务
 *
 * 依赖：puppeteer-core（devDep）+ 本机 Edge/Chrome（可用 PRERENDER_BROWSER 覆盖）；tsx 运行以导入内置剧本清单
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { builtinScenarios } from '../src/wenyou/scenarios/index.ts';
import { SEO_PAGES, seoPagePath } from '../src/seo/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const PORT = 4174;
const BASE_URL = process.env.PRERENDER_BASE_URL || `http://127.0.0.1:${PORT}`;

const BROWSER_CANDIDATES = [
  process.env.PRERENDER_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

const executablePath = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('[prerender] 未找到 Edge/Chrome，请设置环境变量 PRERENDER_BROWSER 指向浏览器可执行文件');
  process.exit(1);
}
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('[prerender] dist/index.html 不存在，请先运行 npx vite build');
  process.exit(1);
}

/** 杀掉整个进程树（Windows：taskkill /T 连同 npx/vite 子进程一起清，避免端口残留） */
function killTree(pid: number): void {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* 忽略 */ }
}

/** 探测服务是否就绪（node:http 直连，避免 fetch 被 HTTP_PROXY 环境变量劫持） */
function probeOk(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 启动 vite preview 静态服务（stdio ignore，不捕获子进程输出）；已设 PRERENDER_BASE_URL 则跳过 */
function startPreview(): Promise<ReturnType<typeof spawn> | null> {
  if (process.env.PRERENDER_BASE_URL) {
    console.log(`[prerender] 使用已有服务 ${BASE_URL}（PRERENDER_BASE_URL）`);
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    // Windows 下用 cmd /c 单串命令启动；--host 127.0.0.1 强制 IPv4 绑定（vite 默认可能只绑 IPv6 回环）
    const child = spawn('cmd.exe', ['/c', `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`], {
      cwd: root,
      stdio: 'ignore',
    });
    const deadline = Date.now() + 30000;
    const poll = async () => {
      if (await probeOk(`${BASE_URL}/`)) return resolve(child);
      if (Date.now() > deadline) {
        killTree(child.pid ?? 0);
        return reject(new Error('[prerender] vite preview 启动超时'));
      }
      setTimeout(poll, 1000);
    };
    poll();
    child.on('exit', (code) => reject(new Error(`[prerender] vite preview 退出 code=${code}`)));
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 清理快照噪音：去掉 IDE inspector（trae-inspector-*）注入的属性 */
function sanitizeHtml(html: string): string {
  return html.replace(/\s+trae-inspector-[\w-]+="[^"]*"/g, '');
}

/** 抓取一个路由并保存快照 */
async function snapshot(page: import('puppeteer-core').Page, routePath: string, outFile: string, waitFor: string): Promise<void> {
  console.log(`[prerender] 抓取 ${routePath} -> ${outFile}（等待 ${waitFor}）`);
  await page.goto(`${BASE_URL}${routePath}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector(waitFor, { timeout: 60000 });
  await sleep(1200); // 让懒加载/字体/图片稳定
  const html = sanitizeHtml(await page.content());
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, html, 'utf8');
  console.log(`[prerender] 已写入 ${outFile}（${html.length} 字节）`);
}

async function main(): Promise<void> {
  console.log(`[prerender] 浏览器: ${executablePath}`);
  const preview = await startPreview();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--disable-gpu', '--no-first-run', '--disable-extensions'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 动态生成千世书分享入口页路由：每个内置剧本 + 每个开局（/s/<id>/ 与 /s/<id>-<i>/）
    const shareRoutes: { path: string; out: string }[] = [];
    for (const sc of builtinScenarios) {
      shareRoutes.push({ path: `/s/${sc.id}/`, out: path.join(dist, 's', sc.id, 'index.html') });
      for (let i = 0; i < (sc.openings?.length ?? 0); i++) {
        shareRoutes.push({
          path: `/s/${sc.id}-${i}/`,
          out: path.join(dist, 's', `${sc.id}-${i}`, 'index.html'),
        });
      }
    }

    // 路由表：waitFor 为内容就绪信号
    const routes = [
      {
        path: '/',
        out: path.join(dist, 'index.html'),
        waitFor: 'h1',
        // 首页有隐私同意门：快照上下文标记「已同意」，让爬虫直接看到品牌正文。
        // 同时标记「已弹过注册弹窗」，否则全新上下文会触发 Home 的 600ms 自动注册弹窗，
        // 把 AuthModal 烙进静态 HTML——已登录用户拿到后会先看到弹窗、水合后才消失（闪现）。
        setup: () =>
          page.evaluateOnNewDocument(() => {
            try { localStorage.setItem('cure_privacy_agreed', '1'); } catch { /* 忽略 */ }
            try { localStorage.setItem('cure_reg_prompted', '1'); } catch { /* 忽略 */ }
            try { localStorage.setItem('cure_guest_prompted', '1'); } catch { /* 忽略 */ }
          }),
      },
      { path: '/faq', out: path.join(dist, 'faq', 'index.html'), waitFor: '#faq-jsonld' },
      // 公开隐私政策页：给 Google OAuth 同意屏幕一个可访问的静态 URL，同时利于爬虫抓取
      { path: '/privacy', out: path.join(dist, 'privacy', 'index.html'), waitFor: 'h1' },
      // SEO/GEO 落地内容页（公开）：路由与输出路径全部由 src/seo 注册表派生
      // —— 新增一个内容页只需在 src/seo/*.ts 加一条数据，本脚本无需改动
      ...SEO_PAGES.map((p) => {
        const urlPath = seoPagePath(p); // '/what-is-ai-companion' | '/zh/ai-roleplay'
        return {
          path: `${urlPath}/`,
          out: path.join(dist, ...urlPath.split('/').filter(Boolean), 'index.html'),
          waitFor: '#seo-root',
        };
      }),
      ...shareRoutes.map((r) => ({ ...r, waitFor: 'h1' })),
    ];

    for (const route of routes) {
      if (route.setup) await route.setup();
      await snapshot(page, route.path, route.out, route.waitFor);
    }
    console.log(`[prerender] 完成：${routes.length} 个页面`);
  } finally {
    if (browser) await browser.close();
    if (preview) killTree(preview.pid ?? 0); // 杀整个进程树，防止 vite 孙进程残留占端口
  }
}

main().catch((err) => {
  console.error('[prerender] 失败:', err.message);
  process.exit(1);
});
