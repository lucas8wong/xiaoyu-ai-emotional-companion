/**
 * 账户模块（自建账号系统）
 * - 用户名/手机号 + 密码注册登录（手机号不验证，仅作账号标识）
 * - 邮箱必填，用于找回密码
 * - 密码 PBKDF2 哈希存储
 * - Token 会话管理（30天），持久化到 data/accounts.json + data/tokens.json
 */

import 'dotenv/config';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const ACCOUNTS_FILE = dataFile('accounts.json');
const TOKENS_FILE = dataFile('tokens.json');

const TOKEN_TTL = Number(process.env.TOKEN_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;
// 旧账户（历史）使用的迭代次数；登录成功后自动升级到当前强度
const LEGACY_ITERATIONS = 12000;
// 当前密码散列强度（OWASP 建议 PBKDF2-SHA256 ≥ 600k；兼顾单机登录延迟取 310k）
const PBKDF2_ITERATIONS = 310000;

export interface Account {
  userId: string;
  username?: string;
  phone?: string;
  email: string;
  /** 密码散列。**Google 等第三方登录建的账号为空串**（没有密码），见 hasPassword() */
  passwordHash: string;
  salt: string;
  iterations?: number; // 散列迭代次数（旧账户缺失时按 LEGACY_ITERATIONS 校验并自动升级）
  createdAt: number;
  /** Google 的稳定用户标识（ID token 的 sub）。用于「同一个人换邮箱也登得回来」，与 email 无关 */
  googleSub?: string;
  /** 已绑定的第三方登录方式（目前只有 'google'）。仅作展示/排障；鉴权一律以 googleSub 为准 */
  providers?: string[];
}

interface TokenRecord {
  token: string;
  userId: string;
  expireAt: number;
}

function hashPassword(password: string, salt: string, iterations: number = PBKDF2_ITERATIONS): string {
  return crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha256').toString('hex');
}

function normalize(value: string | undefined): string {
  return (value || '').trim();
}

class AccountStore {
  private accounts: Map<string, Account> = new Map(); // userId -> account
  private tokens: Map<string, TokenRecord> = new Map(); // token -> record

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsedAccounts = readJson<Account[]>(ACCOUNTS_FILE, []);
    if (Array.isArray(parsedAccounts)) parsedAccounts.forEach((a: Account) => { if (a?.userId) this.accounts.set(a.userId, a); });
    const parsedTokens = readJson<TokenRecord[]>(TOKENS_FILE, []);
    if (Array.isArray(parsedTokens)) parsedTokens.forEach((t: TokenRecord) => { if (t?.token) this.tokens.set(t.token, t); });
    console.log(`💾 [Accounts] 已加载 ${this.accounts.size} 个账号, ${this.tokens.size} 个会话`);
  }

  private saveAccounts(): void {
    try {
      writeJson(ACCOUNTS_FILE, Array.from(this.accounts.values()));
    } catch (e) {
      console.warn('⚠️ [Accounts] 保存账号失败:', (e as Error)?.message);
    }
  }

  private saveTokens(): void {
    try {
      writeJson(TOKENS_FILE, Array.from(this.tokens.values()));
    } catch (e) {
      console.warn('⚠️ [Tokens] 保存会话失败:', (e as Error)?.message);
    }
  }

  /**
   * 注册新账号
   */
  register(input: { username?: string; phone?: string; email: string; password: string }): { user: Account | null; error?: string } {
    const username = normalize(input.username);
    const phone = normalize(input.phone);
    const email = normalize(input.email).toLowerCase();
    const password = input.password || '';

    // 邮箱校验：禁止连续点/结尾点；至少两级域名（兼容国际化域名如 测试@邮箱.中国）
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /\.\./.test(email) || /\.$/.test(email)) {
      return { user: null, error: '邮箱格式不正确' };
    }
    if (password.length < 6) return { user: null, error: '密码至少6位' };
    if (!username && !phone) return { user: null, error: '用户名或手机号至少填一个' };
    // 昵称（用户名）仅作展示名，不强制唯一（唯一标识是 userId）：允许同一默认名「小愈的朋友」被多人使用
    if (phone && this.findByPhone(phone)) return { user: null, error: '手机号已被注册' };
    if (this.findByEmail(email)) return { user: null, error: '该邮箱已注册' };

    const salt = crypto.randomBytes(16).toString('hex');
    const user: Account = {
      userId: uuidv4(),
      username: username || undefined,
      phone: phone || undefined,
      email,
      passwordHash: hashPassword(password, salt),
      salt,
      iterations: PBKDF2_ITERATIONS,
      createdAt: Date.now(),
    };
    this.accounts.set(user.userId, user);
    this.saveAccounts();
    return { user };
  }

  findByUsername(username: string): Account | undefined {
    const u = normalize(username);
    for (const a of this.accounts.values()) if (a.username === u) return a;
    return undefined;
  }

  findByPhone(phone: string): Account | undefined {
    const p = normalize(phone);
    for (const a of this.accounts.values()) if (a.phone === p) return a;
    return undefined;
  }

  findByEmail(email: string): Account | undefined {
    const e = normalize(email).toLowerCase();
    for (const a of this.accounts.values()) if (a.email === e) return a;
    return undefined;
  }

  /** 按 Google 子标识（sub）查账号 */
  findByGoogleSub(googleSub: string): Account | undefined {
    const sub = normalize(googleSub);
    if (!sub) return undefined;
    for (const a of this.accounts.values()) if (a.googleSub === sub) return a;
    return undefined;
  }

  /** 该账号是否设置过密码（Google 建的账号一开始没有；走「找回密码」即可补上） */
  hasPassword(user: Account): boolean {
    return Boolean(user.passwordHash && user.salt);
  }

  /**
   * Google 首次建号：**不设密码**（passwordHash/salt 为空串）。
   * 这类账号只能通过 Google 登录，或先「找回密码」设一个密码再用密码登录。
   */
  createOAuthAccount(input: { email: string; googleSub: string; username?: string }): { user: Account | null; error?: string } {
    const email = normalize(input.email).toLowerCase();
    // 与 register() 同一套邮箱校验（禁止连续点/结尾点；至少两级域名）
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /\.\./.test(email) || /\.$/.test(email)) {
      return { user: null, error: '邮箱格式不正确' };
    }
    if (this.findByEmail(email)) return { user: null, error: '该邮箱已注册' };
    if (input.googleSub && this.findByGoogleSub(input.googleSub)) return { user: null, error: '该 Google 账号已绑定其它账户' };
    const username = normalize(input.username).slice(0, 20);
    const user: Account = {
      userId: uuidv4(),
      username: username || undefined,
      email,
      passwordHash: '',
      salt: '',
      createdAt: Date.now(),
      googleSub: input.googleSub,
      providers: ['google'],
    };
    this.accounts.set(user.userId, user);
    this.saveAccounts();
    return { user };
  }

  /**
   * 把 Google 子标识绑到已有账号（子标识已在路由层验签，这里只落库 + 去重）。
   * 返回 false 的情况：账号不存在 / 空 sub / 该账号已绑别的 Google 账号 / 该 Google 账号已绑别人。
   */
  linkGoogle(userId: string, googleSub: string): boolean {
    const acc = this.accounts.get(userId);
    const sub = normalize(googleSub);
    if (!acc || !sub) return false;
    if (acc.googleSub && acc.googleSub !== sub) return false;
    const existing = this.findByGoogleSub(sub);
    if (existing && existing.userId !== userId) return false;
    acc.googleSub = sub;
    const providers = new Set(acc.providers || []);
    providers.add('google');
    acc.providers = Array.from(providers);
    this.saveAccounts();
    return true;
  }

  /**
   * 列出所有账号（用于管理端）
   */
  listAll(): Account[] {
    return Array.from(this.accounts.values());
  }

  /**
   * 按 userId 查找账号
   */
  getById(userId: string): Account | undefined {
    return this.accounts.get(userId);
  }

  verifyPassword(user: Account, password: string): boolean {
    // 第三方登录（Google）建的账号没有密码 → 一律不能走密码登录。
    // 空串/空盐绝不能与"用户输入空密码"匹配成功，所以这里先挡一道。
    if (!user.passwordHash || !user.salt) return false;
    const iters = user.iterations || LEGACY_ITERATIONS;
    if (hashPassword(password, user.salt, iters) !== user.passwordHash) return false;
    // 旧散列强度 → 登录成功后透明升级到当前强度（下一次登录即生效）
    if (iters < PBKDF2_ITERATIONS) {
      user.iterations = PBKDF2_ITERATIONS;
      user.passwordHash = hashPassword(password, user.salt, PBKDF2_ITERATIONS);
      this.saveAccounts();
    }
    return true;
  }

  /**
   * 创建登录会话
   */
  createToken(userId: string): string {
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.set(token, { token, userId, expireAt: Date.now() + TOKEN_TTL });
    this.saveTokens();
    return token;
  }

  getTokenUser(token: string): Account | null {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (rec.expireAt < Date.now()) {
      this.tokens.delete(token);
      this.saveTokens();
      return null;
    }
    return this.accounts.get(rec.userId) || null;
  }

  revokeToken(token: string): void {
    if (this.tokens.delete(token)) this.saveTokens();
  }

  changePassword(userId: string, newPassword: string): boolean {
    const user = this.accounts.get(userId);
    if (!user) return false;
    user.salt = crypto.randomBytes(16).toString('hex');
    user.iterations = PBKDF2_ITERATIONS;
    user.passwordHash = hashPassword(newPassword, user.salt);
    this.saveAccounts();
    return true;
  }

  getPublic(user: Account) {
    return {
      userId: user.userId,
      username: user.username || null,
      phone: user.phone || null,
      email: user.email,
    };
  }

  /**
   * 删除账号
   */
  deleteAccount(userId: string): void {
    if (this.accounts.delete(userId)) this.saveAccounts();
  }

  /**
   * 修改用户名（昵称）
   */
  rename(userId: string, username: string): { ok: boolean; error?: string } {
    const name = normalize(username);
    if (!name) return { ok: false, error: '昵称不能为空' };
    if (name.length > 20) return { ok: false, error: '昵称最多20个字符' };
    const acc = this.accounts.get(userId);
    if (!acc) return { ok: false, error: '账号不存在' };
    // 昵称仅作展示名，不强制唯一：允许与他人同名（唯一标识是 userId）
    acc.username = name;
    this.saveAccounts();
    return { ok: true };
  }

  /**
   * 注销该用户的所有登录会话
   */
  revokeAllTokens(userId: string): void {
    let changed = false;
    for (const [token, rec] of this.tokens.entries()) {
      if (rec.userId === userId) {
        this.tokens.delete(token);
        changed = true;
      }
    }
    if (changed) this.saveTokens();
  }
}

export const accountStore = new AccountStore();
export default accountStore;
