/**
 * 环境变量加载（副作用模块）：
 * 同时加载 .env 与 .env.local，且 .env.local 优先覆盖。
 * 必须在任何「读 process.env 的模块」之前 import（ESM 按 import 顺序先执行本模块）。
 * 用途：皮肤生成器把敏感 Key（如 VOLCENGINE_API_KEY）放 .env.local（gitignore），不污染 .env。
 */
import dotenv from 'dotenv';

dotenv.config();
// .env.local 覆盖 .env（本地/敏感覆盖；文件不存在则静默跳过）
dotenv.config({ path: '.env.local', override: true });
