/**
 * This is a API server
 */

import './services/env.js'; // 副作用：同时加载 .env 与 .env.local（须最先执行）
import express, { type Request, type Response, type NextFunction }  from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { SEO_PAGES, seoPagePath } from '../src/seo/index.js';
import authRoutes from './routes/auth.js';
import analysisRoutes from './routes/analysis.js';
import paymentRoutes from './routes/payment.js';
import paymentAdminRoutes from './routes/paymentAdmin.js';
import diaryRoutes from './routes/diary.js';
import userRoutes from './routes/user.js';
import roleplayRoutes from './routes/roleplay.js';
import textgameRoutes from './routes/textgame.js';
import wenyouScenarioRoutes from './routes/wenyouScenarios.js';
import instagramRoutes from './routes/instagram.js';
import ttsRoutes from './routes/tts.js';
import geoRoutes from './routes/geo.js';
import skinAdminRoutes from './routes/skinAdmin.js';
import skinUsageRoutes from './routes/skinUsage.js';
import pwaInstallRoutes from './routes/pwaInstall.js';
import usageTimeRoutes from './routes/usageTime.js';
import stickersRoutes from './routes/stickers.js';
import asrRoutes from './routes/asr.js';
import linkPreviewRoutes from './routes/linkPreview.js';
import reengageRoutes from './routes/reengage.js';
import journeyRoutes from './routes/journey.js';
import referralRoutes from './routes/referral.js';
import werewolfRoutes from './routes/werewolf.js';
import aiFailureRoutes from './routes/aiFailure.js';
// wolfcha 子应用兼容层：上游客户端把模型调用打到 /api/chat，这里按同一契约转发到小愈自己的 DeepSeek
import wolfchaCompatRoutes from './routes/wolfchaCompat.js';

// for esm mode
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load env
dotenv.config();


const app: express.Application = express();

// 关闭 Express 指纹，避免暴露技术栈
app.disable('x-powered-by');
// 信任反向代理（Cloudflare/Vercel）：让 req.ip 取真实客户端 IP，
// 否则访客身份 = hash(deviceId + 代理IP) 会因代理 IP 变化而漂移，导致会话/配额/偏好丢失。
//
// ⚠️ 安全边界（2026-09-28 审查 P1-6）：开启 trust proxy 后 req.ip = **最左**的 X-Forwarded-For，
// 而该值由调用方提供（Cloudflare 对入站 XFF 是「追加」而非改写）→ 可被伪造。
// 因此**限流、游客身份、防滥用一律用 getClientIp(req)**（优先 cf-connecting-ip，Cloudflare 会覆盖它），
// 不要再用 req.ip 做安全判定；req.ip 只保留给审计日志等低风险用途。
app.set('trust proxy', true);

// gzip 压缩静态资源与接口响应（大幅减少首次访问下载量）
app.use(compression());
// CORS：仅放行同源前端与本站运营域名，避免任意网站跨域调用（含用户 token 的）接口
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (ALLOWED_ORIGINS.length === 0 && process.env.NODE_ENV === 'production') {
  console.warn('⚠️ [Security] 生产环境未配置 CORS_ORIGINS：将放行所有跨域来源。建议在 .env 配置 CORS_ORIGINS 白名单。');
}
app.use(cors({
  origin: (origin, cb) => {
    // 无 Origin（同源请求、curl、服务端调用）放行
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true); // 未配置白名单时保持兼容
    if (ALLOWED_ORIGINS.includes(origin) || origin === 'http://localhost:3001' || origin === 'https://myxiaoyu.com' || origin.endsWith('.myxiaoyu.com')) {
      return cb(null, true);
    }
    // 非白名单来源：静默不返回 CORS 头（浏览器会拦截跨域读取），不抛错
    return cb(null, false);
  },
  credentials: false,
}));
app.use(express.json({ limit: '10mb', verify: (req: Request, _res: Response, buf: Buffer) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/**
 * API Routes
 */
app.use('/api/auth', authRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/payment/admin', paymentAdminRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/diary', diaryRoutes);
app.use('/api', userRoutes);
app.use('/api/roleplay', roleplayRoutes);
app.use('/api/textgame', textgameRoutes);
app.use('/api/wenyou', wenyouScenarioRoutes);
app.use('/api/instagram', instagramRoutes);
app.use('/api/geo', geoRoutes);
app.use('/api/skin/admin', skinAdminRoutes);
app.use('/api/skin/usage', skinUsageRoutes); // POST /api/skin/usage 用户当前皮肤上报
app.use('/api/pwa/install', pwaInstallRoutes); // POST /api/pwa/install 用户安装/下载 Xiaoyu 上报
app.use('/api/usage-time', usageTimeRoutes); // POST /api/usage-time/hit 用户活跃时长上报
app.use('/api/ai-failure', aiFailureRoutes); // POST /api/ai-failure 前端「这一轮 AI 没接上」埋点（无用户内容）
app.use('/api/stickers', stickersRoutes); // GET /api/stickers/search 表情包在线搜索（默认未配置）
app.use('/api/link-preview', linkPreviewRoutes); // GET /api/link-preview 链接卡片元信息 + /image 图片代理
app.use('/api/reengage', reengageRoutes); // POST /api/reengage/run 召回（admin）+ GET /api/reengage/unsubscribe 退订
app.use('/api/journey', journeyRoutes); // GET /api/journey «与你的旅程» 聚合
app.use('/api/referral', referralRoutes); // GET /api/referral/summary 我的邀请记录（邀请反馈区）
app.use('/api/werewolf', werewolfRoutes); // AI 狼人杀：开局/动作/对局列表（服务端权威规则 + 视角过滤）
app.use('/api', wolfchaCompatRoutes); // wolfcha 子应用：/api/chat 按上游契约转发到小愈自己的 DeepSeek
app.use('/api', ttsRoutes); // POST /api/tts 朗读合成
app.use('/api', asrRoutes); // POST /api/asr 语音转文字（服务端 Whisper）

/**
 * 生产模式：托管前端构建产物 + 静态资源
 */
const projectRoot = path.join(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const publicDir = path.join(projectRoot, 'public');
// 控制台页面：禁用缓存，避免浏览器展示旧版乱码
app.get('/admin.html', (req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
// 首页 HTML 禁用缓存：保证浏览器始终加载最新 bundle（避免看到旧版介绍内容）
app.use((req: Request, res: Response, next: NextFunction): void => {
  if (req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
// 只要构建产物存在就托管前端，不再依赖 NODE_ENV：
// 服务器启动/守护重启时若漏设 NODE_ENV=production，首页/静态仍能正确服务，
// 不会因静态分支被跳过而让 / 落到 API 404/500（此前线上首页间歇报错即由此引起）。
if (fs.existsSync(distDir)) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn('⚠️ [Static] NODE_ENV 非 production，但检测到 dist 构建产物，仍托管前端（首页可访问）。建议用 NODE_ENV=production 启动。');
  }
  // 预渲染静态页直达：命中 sitemap 里的公开页（/faq + `src/seo` 注册表里的全部内容页，含 /zh/*）时
  // 直接返回快照，避免 express.static 把 dist/<目录> 301 到带尾斜杠的地址
  // 保证 sitemap 与站内链接里的**无尾斜杠 URL 一次请求直达内容**（少一跳，收录更快）。
  // 路径清单由注册表派生：新增内容页不需要再改本文件（此前是硬编码数组，加页必漏）。
  const prerenderedPaths = new Set<string>(['/faq']);
  for (const page of SEO_PAGES) prerenderedPaths.add(seoPagePath(page));
  app.use((req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET') return next();
    const clean = req.path.replace(/\/+$/, '') || '/';
    if (!prerenderedPaths.has(clean)) return next();
    const file = path.join(distDir, ...clean.split('/').filter(Boolean), 'index.html');
    if (!fs.existsSync(file)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  });
  // 静态资源缓存：带 hash 的 JS/CSS 与图片缓存 7 天；HTML 不缓存（保证拿到最新 bundle）
  const staticOpts = {
    maxAge: '7d',
    setHeaders: (res: Response, filePath: string) => {
      if (filePath.endsWith('.html')) { res.setHeader('Cache-Control', 'no-cache'); return; }
      // Service Worker：禁止长时间缓存，否则浏览器整周用旧 sw.js，通知图标/逻辑不更新
      if (path.basename(filePath) === 'sw.js') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return;
      }
      // 狼人杀子应用样式（public/wolfcha.css / wolfcha-overrides.css）：文件名不带 hash、内容随每次样式改动而变。
      // 默认 7 天缓存会让「改了样式线上看不到」，实测边缘已命中 Age≈41h 的旧文件，而源站早已是新内容。
      // 这里与 .html 同口径：必须回源校验（ETag/304），改样式即时生效。
      if (filePath.endsWith('wolfcha.css') || filePath.endsWith('wolfcha-overrides.css')) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      // 主持人旁白音频（/audio/narrator/*）：内容稳定但**失败即静默**（拿到 HTML 旧响应 → 解码失败 → 没声音、无报错），
      // 一旦被边缘缓存住错误响应会持续一周。改为必须回源校验（小文件，304 成本可忽略），保证「要么有声、要么立刻暴露」。
      if (filePath.split(path.sep).includes('narrator')) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      // 头像 URL 已按内容 hash 版本化（?v=），可安全长期缓存且 immutable，换图即换 URL 自动失效
      if (filePath.split(path.sep).includes('img') && filePath.split(path.sep).includes('roleplay')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      // 皮肤清单/元数据（/skins/*.json）动态更新，禁止缓存，否则新增皮肤 7 天内不生效
      if (filePath.split(path.sep).includes('skins') && filePath.endsWith('.json')) {
        res.setHeader('Cache-Control', 'no-store');
      }
      // 自托管展示字体（/fonts/…）：稳定资源，长期缓存 immutable，重复访问/已选过的字体即时命中
      if (filePath.includes('fonts') && (filePath.endsWith('.woff2') || filePath.endsWith('.ttf'))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  };
  app.use(express.static(distDir, staticOpts));
  app.use(express.static(publicDir, staticOpts));
  // 敏感路径直接 404：不返回 index.html，避免探测者误以为能访问敏感文件
  app.use((req: Request, res: Response, next: NextFunction) => {
    const p = req.path.toLowerCase();
    const blocked =
      p.startsWith('/.') ||            // 隐藏文件（.env/.git/.htaccess…）
      p.includes('/.') ||               // 任何路径段中的隐藏文件
      p.startsWith('/data/') ||         // 运行时数据目录
      /.(env|git|sql|log|ts|tsx|json|lock|bak|tmp)$/.test(p); // 常见敏感扩展
    if (blocked) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    next();
  });
  // SPA fallback：非 /api 的 GET 请求回 index.html
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

/**
 * health
 */
app.use('/api/health', (req: Request, res: Response, _next: NextFunction): void => {
  res.status(200).json({
    success: true,
    message: 'ok'
  });
});

/**
 * error handler middleware
 */
app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
  // 内部错误详情只进服务器日志，不返回给客户端（避免泄露技术栈/配置）。
  // 生成 requestId 并同时写入日志与响应：用户把响应里的 requestId 发回来即可
  // 与服务器日志的 [Unhandled] 行关联，快速定位是哪个接口/用户/设备抛的异常。
  const requestId = crypto.randomBytes(4).toString('hex');
  const deviceId = String(req.headers['x-device-id'] || '').slice(0, 24);
  const authed = String(req.headers['authorization'] || '').startsWith('Bearer ');
  console.error(`[Unhandled] requestId=${requestId} method=${req.method} path=${req.path} auth=${authed} device=${deviceId}`, error instanceof Error ? (error.stack || error.message) : String(error));
  res.status(500).json({
    success: false,
    error: 'Server internal error',
    requestId
  });
});

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found'
  });
});

export default app;