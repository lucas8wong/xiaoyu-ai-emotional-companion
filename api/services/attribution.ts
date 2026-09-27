/**
 * 来源归因 · 服务端（匿名设备触点 → 账号身份 stitch）
 *
 * 身份图（对齐 `.dsh/skills/attribution` Pillar B）：
 *   1. 匿名阶段：客户端每次落地把触点报上来（`POST /api/analysis/visit` 携带 `attr`），
 *      服务端按 `X-Device-Id` 记住该设备的 **first-touch + 触点路径**；
 *   2. 转化时刻：注册接口（`POST /api/auth/register`）带着同一个设备 id 进来，
 *      把设备上的 first-touch 落到**账号**上 —— 这就是 identify/merge，
 *      否则「注册用户全都像是凭空出现的」是这类实现最常见的失败模式；
 *   3. 报表：`GET /api/payment/admin/attribution` 按来源聚合 访问设备 / 注册 / 付费用户。
 *
 * 数据边界（重要）：
 *   - 只存**渠道维度**：source / medium / campaign / content / term / referrer 主机 / 落地路径；
 *   - **不存 IP、不存邮箱、不存任何用户输入**；referrer 主机已剔除自家域与 OAuth/结账跳转；
 *   - 与 `data/accounts.json` 等真实用户数据**完全分离**，本文件只做渠道统计；
 *   - 设备/账号记录超期（400 天）自动清理，上限保护避免无限增长。
 *
 * 边界与不做：不做跨设备合并、不做多触点加权模型（first-touch + 路径已能回答
 * 「哪个渠道带来注册」；加权模型等有量了再说，避免用一个假设冒充结论）。
 */
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

export interface AttrTouch {
  source: string;
  medium: string;
  campaign: string;
  content: string;
  term: string;
  refHost: string;
  path: string;
  at: number;
}

interface DeviceAttr {
  deviceId: string;
  first: AttrTouch;
  last: AttrTouch;
  path: AttrTouch[];
  updatedAt: number;
}

/** 一行渠道汇总（first-touch / last-touch 两个维度共用） */
export interface AttrRow {
  source: string;
  medium: string;
  campaign: string;
  devices: number;
  signups: number;
  paidUsers: number;
  /** 该来源占全部「有触点设备」的比例（direct 的占比就是最该看的那个数） */
  directShare?: number;
}

interface UserAttr {
  userId: string;
  deviceId: string;
  /** first-touch 触点；**仅自报来源**（注册时回答了「你怎么知道我们的」但没有任何旅程数据）时为 null */
  first: AttrTouch | null;
  path: AttrTouch[];
  /** 自报来源（「你怎么知道我们的」）；null 表示未问/未答 */
  heardFrom: string | null;
  /** 归因依据（对齐 attribution 技能：来源要带 basis，别把两种口径混成一个数）：
   *  journey = 有旅程链路（设备/客户端触点）；self-report = 只有用户自报 */
  basis: 'journey' | 'self-report';
  at: number;
}

interface AttrFile {
  version: 1;
  devices: Record<string, DeviceAttr>;
  users: Record<string, UserAttr>;
}

const FILE = dataFile('attribution.json');
const RETENTION_MS = 400 * 24 * 3600 * 1000;
const MAX_DEVICES = 20000;
const PATH_CAP = 10;

const EMPTY: AttrFile = { version: 1, devices: {}, users: {} };

/** 清洗单字段：限长 + 只留安全字符（防止把脚本/换行/超长串写进统计文件） */
function clean(value: unknown, max = 64): string {
  return String(value ?? '')
    // 这里**故意**匹配控制字符（\u0000-\u001f）——目的就是把它们剔掉；
    // 所以对本行关掉 no-control-regex（不是漏写，是规则与意图相反）。
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>"']/g, '')
    .trim()
    .slice(0, max);
}

function sanitizeTouch(raw: unknown, now = Date.now()): AttrTouch | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const source = clean(t.source, 48).toLowerCase();
  if (!source) return null;
  return {
    source,
    medium: clean(t.medium, 32).toLowerCase(),
    campaign: clean(t.campaign, 64).toLowerCase(),
    content: clean(t.content, 64),
    term: clean(t.term, 64),
    refHost: clean(t.refHost, 64).toLowerCase(),
    path: clean(t.path, 96) || '/',
    at: Number.isFinite(Number(t.at)) ? Number(t.at) : now,
  };
}

function touchKey(t: AttrTouch): string {
  return [t.source, t.medium, t.campaign, t.path].join('|');
}

function pushPath(list: AttrTouch[], t: AttrTouch): AttrTouch[] {
  const out = Array.isArray(list) ? list : [];
  if (out.some((x) => touchKey(x) === touchKey(t))) return out.slice(-PATH_CAP);
  return [...out, t].slice(-PATH_CAP);
}

class AttributionStore {
  private data: AttrFile;
  private loaded = false;
  private dirty = false;

  constructor() {
    this.data = EMPTY;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = readJson<AttrFile>(FILE, EMPTY);
      this.data = {
        version: 1,
        devices: parsed?.devices && typeof parsed.devices === 'object' ? parsed.devices : {},
        users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {},
      };
    } catch {
      this.data = EMPTY;
    }
  }

  private save(): void {
    if (!this.dirty) return;
    try {
      writeJson(FILE, this.data);
      this.dirty = false;
    } catch (e) {
      console.warn('⚠️ [Attribution] 保存失败:', (e as Error)?.message);
    }
  }

  /** 超期清理 + 设备上限（保留最近的，避免文件无限增长） */
  private prune(now = Date.now()): void {
    let removed = 0;
    for (const [id, d] of Object.entries(this.data.devices)) {
      if (!d || now - (d.updatedAt || 0) > RETENTION_MS) {
        delete this.data.devices[id];
        removed++;
      }
    }
    const ids = Object.keys(this.data.devices);
    if (ids.length > MAX_DEVICES) {
      ids
        .sort((a, b) => (this.data.devices[a].updatedAt || 0) - (this.data.devices[b].updatedAt || 0))
        .slice(0, ids.length - MAX_DEVICES)
        .forEach((id) => {
          delete this.data.devices[id];
          removed++;
        });
    }
    if (removed) this.dirty = true;
  }

  /** 匿名触点上报（每次落地一次，按设备记住 first-touch 与路径） */
  recordTouch(deviceId: string, rawTouch: unknown): void {
    const device = clean(deviceId, 24);
    if (!device) return;
    const touch = sanitizeTouch(rawTouch);
    if (!touch) return;
    this.load();
    const now = Date.now();
    const existing = this.data.devices[device];
    if (existing && existing.first?.source) {
      this.data.devices[device] = {
        ...existing,
        last: touch,
        path: pushPath(existing.path, touch),
        updatedAt: now,
      };
    } else {
      this.data.devices[device] = {
        deviceId: device,
        first: touch, // 首次落地＝first-touch，之后永不覆盖
        last: touch,
        path: [touch],
        updatedAt: now,
      };
    }
    this.dirty = true;
    if (Object.keys(this.data.devices).length % 200 === 0) this.prune(now);
    this.save();
  }

  /**
   * 注册时刻的 identify/merge：把该设备上的 first-touch 落到账号上。
   * 客户端传来的 first 优先（它才是「真正第一次落地的那个来源」，比服务端可能缺失更可靠）；
   * 同时收下**自报来源**（「你怎么知道我们的」）——它和旅程链路是两种口径，分开存（basis）。
   */
  recordSignup(userId: string, deviceId: string, clientAttr?: unknown): UserAttr | null {
    const uid = clean(userId, 64);
    if (!uid) return null;
    this.load();
    const device = clean(deviceId, 24);
    const fromDevice = device ? this.data.devices[device] : undefined;

    const raw = clientAttr && typeof clientAttr === 'object' ? (clientAttr as Record<string, unknown>) : null;
    const clientFirst = sanitizeTouch(raw?.first);
    const first = clientFirst || (fromDevice?.first ? { ...fromDevice.first } : null);
    const heardFrom = raw?.heardFrom ? clean(raw.heardFrom, 64) : null;
    // 既没有旅程数据、也没自报：不写假记录（宁缺勿假，避免制造 direct 噪音）
    if (!first && !heardFrom) return null;

    const clientPath = Array.isArray(raw?.path)
      ? (raw.path as unknown[]).map((t) => sanitizeTouch(t)).filter((t): t is AttrTouch => !!t)
      : [];
    const path = first ? (clientPath.length ? clientPath : fromDevice?.path || [first]).slice(-PATH_CAP) : [];

    const record: UserAttr = {
      userId: uid,
      deviceId: device,
      first,
      path,
      heardFrom,
      basis: first ? 'journey' : 'self-report',
      at: Date.now(),
    };
    this.data.users[uid] = record;
    this.dirty = true;
    this.save();
    return record;
  }

  /** 自报来源（「你怎么知道我们的」）：随时可补填 */
  noteHeardFrom(userId: string, heardFrom: string): boolean {
    const uid = clean(userId, 64);
    const value = clean(heardFrom, 64);
    if (!uid || !value) return false;
    this.load();
    const rec = this.data.users[uid];
    if (!rec) return false;
    rec.heardFrom = value;
    this.dirty = true;
    this.save();
    return true;
  }

  getByUser(userId: string): UserAttr | null {
    this.load();
    return this.data.users[clean(userId, 64)] || null;
  }

  /**
   * 聚合报表：一张数据、四个口径（对齐 attribution 技能：first-touch 与 last-touch **并排看**，
   * 两者的差额本身就是结论；自报来源单独一列，因为它是另一种依据、不能和旅程链路混成一个数）。
   *
   *  - `rows`          first-touch：用户第一次落地时的来源（决策用主口径）
   *  - `lastTouchRows` last-touch：注册前最后一个触点（与 first 并排，差额＝「认知渠道 ≠ 关单渠道」）
   *  - `landingRows`   首次落地页：哪一页最常成为「第一次见到小愈」的那一页（决定补哪类内容）
   *  - `heardFromRows` 自报来源：「你怎么知道我们的」的答案分布（捞回 direct 黑洞里的口口相传）
   *
   * `paidUserIds` 由路由层用订单（status=unlocked 且 source!=='free'）算出后传入，
   * 本模块不直接依赖支付模块（保持边界清晰、便于单测）。
   */
  aggregates(paidUserIds?: Set<string>): {
    totals: {
      devices: number;
      signups: number;
      journeySignups: number;
      selfReportedSignups: number;
      paidUsers: number;
      paidAttributed: number;
    };
    rows: AttrRow[];
    lastTouchRows: AttrRow[];
    landingRows: { path: string; devices: number; signups: number; paidUsers: number }[];
    heardFromRows: { label: string; accounts: number; paidUsers: number }[];
  } {
    this.load();

    const firstMap = new Map<string, AttrRow>();
    const lastMap = new Map<string, AttrRow>();
    const landingMap = new Map<string, { path: string; devices: number; signups: number; paidUsers: number }>();
    const heardMap = new Map<string, { label: string; accounts: number; paidUsers: number }>();

    const bumpAttr = (map: Map<string, AttrRow>, t: AttrTouch | null | undefined, add: Partial<AttrRow>) => {
      if (!t?.source) return;
      const key = `${t.source}|${t.medium || ''}|${t.campaign || ''}`;
      const row = map.get(key) || { source: t.source, medium: t.medium || '', campaign: t.campaign || '', devices: 0, signups: 0, paidUsers: 0 };
      row.devices += add.devices || 0;
      row.signups += add.signups || 0;
      row.paidUsers += add.paidUsers || 0;
      map.set(key, row);
    };
    const bumpLanding = (path: string | undefined, add: { devices?: number; signups?: number; paidUsers?: number }) => {
      const key = path || '/';
      const row = landingMap.get(key) || { path: key, devices: 0, signups: 0, paidUsers: 0 };
      row.devices += add.devices || 0;
      row.signups += add.signups || 0;
      row.paidUsers += add.paidUsers || 0;
      landingMap.set(key, row);
    };

    // 匿名设备侧：first / last / 首次落地页
    for (const d of Object.values(this.data.devices)) {
      bumpAttr(firstMap, d?.first, { devices: 1 });
      bumpAttr(lastMap, d?.last, { devices: 1 });
      if (d?.first?.source) bumpLanding(d.first.path, { devices: 1 });
    }

    // 账号侧：first / last / 首次落地页 / 自报来源 / 付费
    let journeySignups = 0;
    let selfReportedSignups = 0;
    let paidUsers = 0;
    let paidAttributed = 0;
    for (const u of Object.values(this.data.users)) {
      if (!u) continue;
      const isPaid = !!paidUserIds?.has(u.userId);
      if (isPaid) paidUsers++;
      if (u.heardFrom) selfReportedSignups++;
      if (u.first?.source) {
        journeySignups++;
        if (isPaid) paidAttributed++;
        bumpAttr(firstMap, u.first, { signups: 1, paidUsers: isPaid ? 1 : 0 });
        bumpAttr(lastMap, u.path?.[u.path.length - 1] || u.first, { signups: 1, paidUsers: isPaid ? 1 : 0 });
        bumpLanding(u.first.path, { signups: 1, paidUsers: isPaid ? 1 : 0 });
      }
      if (u.heardFrom) {
        const row = heardMap.get(u.heardFrom) || { label: u.heardFrom, accounts: 0, paidUsers: 0 };
        row.accounts++;
        if (isPaid) row.paidUsers++;
        heardMap.set(u.heardFrom, row);
      }
    }

    const deviceTotal = Object.keys(this.data.devices).length;
    const signupTotal = Object.keys(this.data.users).length;
    const sortRows = (m: Map<string, AttrRow>): AttrRow[] =>
      [...m.values()]
        .map((r) => ({ ...r, directShare: deviceTotal ? r.devices / deviceTotal : 0 }))
        .sort((a, b) => b.signups - a.signups || b.devices - a.devices);

    return {
      totals: {
        devices: deviceTotal,
        signups: signupTotal,
        journeySignups,
        selfReportedSignups,
        paidUsers,
        paidAttributed,
      },
      rows: sortRows(firstMap),
      lastTouchRows: sortRows(lastMap),
      landingRows: [...landingMap.values()].sort((a, b) => b.signups - a.signups || b.devices - a.devices),
      heardFromRows: [...heardMap.values()].sort((a, b) => b.accounts - a.accounts),
    };
  }
}

export const attributionStore = new AttributionStore();
