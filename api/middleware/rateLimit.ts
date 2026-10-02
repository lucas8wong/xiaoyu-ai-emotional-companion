/**
 * 轻量内存限流中间件（单进程）
 * 按「方法:路径:客户端标识」固定窗口计数，防止登录爆破、验证码轰炸、注册滥用。
 * 注意：本实现为进程内内存计数，重启即清零；多实例部署时应改用 Redis 等共享存储。
 */
import type { Request, Response, NextFunction } from 'express';
import { getClientIp } from '../services/geo.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// 定时清理过期桶，防止内存无限增长
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
if (typeof cleaner.unref === 'function') cleaner.unref();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** 客户端标识：默认 IP，可自定义（如 send-code 用 IP+邮箱，防止同邮箱轰炸） */
  key?: (req: Request) => string;
  message?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, key, message = '请求过于频繁，请稍后再试' } = opts;
  return (req: Request, res: Response, next: NextFunction): void => {
    // 用 getClientIp 而非 req.ip：后者是最左 XFF，可被调用方伪造（2026-09-28 审查 P1-6）
    const client = key ? key(req) : (getClientIp(req) || 'unknown');
    const bucketKey = `${req.method}:${req.path}:${client}`;
    const now = Date.now();

    let b = buckets.get(bucketKey);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, b);
    }
    b.count += 1;

    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      res.status(429).json({ success: false, error: message });
      return;
    }
    next();
  };
}

export default rateLimit;
