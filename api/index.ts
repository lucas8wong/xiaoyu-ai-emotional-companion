/**
 * Vercel deploy entry handler, for serverless deployment, please don't modify this file
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import app from './app.js';

// 提升 serverless 函数最长执行时长：聊一聊含实时资讯/函数调用（多轮生成 + 搜索）可能超过默认 10s
export const config = { maxDuration: 60 };

export default function handler(req: VercelRequest, res: VercelResponse) {
  return app(req, res);
}