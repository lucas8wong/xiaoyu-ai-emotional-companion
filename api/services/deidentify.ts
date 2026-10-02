/**
 * 审阅副本脱敏，「去除账号关联后的人工审阅」的第二道工序。
 *
 * 两道工序分工：
 *   ① 结构层（`reviewQueue.ts`）：审阅副本只带随机代号，**不写 userId / sessionId /
 *      email / phone / username / IP**。内容和身份在存储里本来就是分开的
 *      （`sessions.json` 只有 userId，身份在 `accounts.json`），所以这一层主要是
 *      「不要做那个 join」，从存储层就回不到账号。
 *   ② 正文层（本文件）：账号虽然解绑了，但用户会**在正文里自己报出身份**
 *      （「我叫小明，在澳门读中三」）。不洗掉这层，代号就形同虚设。
 *
 * ⚠️ 边界（对外必须说清，措辞不能用「匿名」）：
 * 正则只能覆盖**有固定形态**的身份（号码、邮箱、账号、链接）。自由写法
 * （「我在氹仔那家茶餐厅打工」「我老公在威尼斯人做荷官」）无法可靠识别。
 * 所以本工序是**降低风险**，不是**保证匿名**，对外一律写「去除账号关联后的人工审阅」。
 *
 * 取舍说明：宁可**过度脱敏**（把不像手机号的 8 位数字也洗掉）也不漏。审阅的价值
 * 在于看对话结构与 AI 回复质量，个别数字被抹掉损失很小；漏一个手机号则不可接受。
 *
 * 本模块**纯函数、零 I/O**：不读 data/、不写盘。这样单测只用假数据，绝不会碰到
 * 真实用户数据（AGENTS.md 红线 3）。
 */

export interface ScrubResult {
  /** 脱敏后的文本 */
  text: string;
  /**
   * 命中的类别 → 次数。
   * ⚠️ 只记**类别**，绝不记原文，把原文记下来等于再泄露一次。
   */
  hits: Record<string, number>;
}

interface Rule {
  /** 命中类别名（进 hits 的 key） */
  name: string;
  re: RegExp;
  /** 替换文本；含捕获组的规则用 `$1` 保留引导词（如「我叫」） */
  to: string;
}

/**
 * 规则**有序**，顺序本身是正确性的一部分：
 *   - 身份证必须排在银行卡前：18 位身份证会被「16~19 位连续数字」先吃掉。
 *   - 邮箱必须排在 @handle 前：否则 `a@b.com` 会先被当成 `@b` 处理。
 *   - data URL 必须排最前：base64 里含有大量数字与字母，会干扰后续所有规则。
 */
const RULES: readonly Rule[] = [
  // 【附件：整段剥掉，绝不进审阅队列（体积 + 隐私双因）】
  { name: '图片', re: /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, to: '[图片]' },
  { name: '语音', re: /data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, to: '[语音]' },

  // 【联系方式】
  { name: '链接', re: /https?:\/\/[^\s，。、；）)】」』"']+/gi, to: '[链接]' },
  { name: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g, to: '[邮箱]' },

  // 【证件与卡号（顺序敏感，见上）】
  // 中国大陆身份证：6 位地区 + 出生日期 + 3 位顺序 + 校验位（可为 X）
  {
    name: '身份证',
    re: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
    to: '[身份证]',
  },
  { name: '银行卡', re: /(?<!\d)\d{16,19}(?!\d)/g, to: '[银行卡]' },

  // 【电话】
  // 中国大陆手机：1 开头 + 11 位
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, to: '[手机号]' },
  // 香港 / 澳门手机：8 位，首位 4/5/6/9（港澳手机号都是 8 位、6 开头在两地都常见）
  { name: '手机号', re: /(?<!\d)[4569]\d{7}(?!\d)/g, to: '[手机号]' },

  // 【社交账号】
  { name: '微信号', re: /wxid_[A-Za-z0-9_-]+/g, to: '[微信号]' },
  {
    name: '微信号',
    re: /(?:微信号|微信號|微信|WeChat|wechat|WX|wx)\s*(?:号|號|id|ID)?\s*[:：]\s*[A-Za-z0-9_-]{4,}/g,
    to: '[微信号]',
  },
  { name: 'QQ', re: /(?:QQ|Qq|qq)\s*(?:号|號)?\s*[:：]?\s*\d{5,12}/g, to: '[QQ]' },
  // @handle：邮箱已在上方处理，这里剩下的 @ 都是社交账号
  { name: '用户名', re: /@[\u4e00-\u9fa5A-Za-z0-9_][\u4e00-\u9fa5A-Za-z0-9_.-]{1,29}/g, to: '[用户名]' },

  // 【自报姓名（保留引导词，否则审阅者读不懂句子）】
  { name: '姓名', re: /(我叫|我的名字叫|我的名字是|我叫做|叫我)\s*[\u4e00-\u9fa5]{2,4}/g, to: '$1[姓名]' },
  {
    name: '姓名',
    // 前缀必须**吃掉** "is"（`my name(?:'s| is)?`）。早先写成 `my name'?s?` 时
    // 两个修饰都可选，于是 "my name is John" 里 "is" 被当成姓名替换掉了。
    // 也不要求姓名首字母大写：本规则带 /i（英文大小写混杂），`[A-Z]` 在 /i 下
    // 形同虚设、并不能当「大写即姓名」的锚点用。
    re: /\b(my name(?:'s| is)?|call me|i'?m called)\s+([A-Za-z][A-Za-z'’-]{1,19})/gi,
    to: '$1 [姓名]',
  },

  // 【就学 / 居住机构（窄口径：只认「引导词 + 机构后缀」的组合）】
  {
    name: '机构',
    re: /(我在|我住|我住在|我來自|我来自|就读于|就讀於|念|讀)\s*[\u4e00-\u9fa5]{2,12}(?:学校|學校|大学|大學|中学|中學|小学|小學|公司|医院|醫院|银行|銀行)/g,
    to: '$1[机构]',
  },
];

/**
 * 对单段文本做脱敏。纯函数、可重复调用（幂等性不保证，重复调用只是再洗一遍，
 * 因为占位符 `[手机号]` 不会命中任何规则）。
 */
export function scrubText(input: unknown): ScrubResult {
  const hits: Record<string, number> = {};
  if (typeof input !== 'string' || input.length === 0) {
    return { text: typeof input === 'string' ? input : '', hits };
  }

  let text = input;
  for (const rule of RULES) {
    // 每条规则都用全新的 RegExp：规则里带 /g，共享实例会把 lastIndex 带到下一次调用
    const re = new RegExp(rule.re.source, rule.re.flags);
    text = text.replace(re, (...args) => {
      hits[rule.name] = (hits[rule.name] || 0) + 1;
      // 有捕获组时回填引导词（如「我叫」）。**手工拼接**而不用 String.replace 的
      // '$1' 语义：捕获组内容若含 `$&`/`$'` 之类会被二次解释，中文昵称里带 $ 并非不可能。
      if (rule.to.includes('$1')) {
        const groups = args.slice(1, -2) as string[];
        const [before = '', after = ''] = rule.to.split('$1');
        return before + (groups[0] ?? '') + after;
      }
      return rule.to;
    });
  }

  return { text, hits };
}

/** 单条消息的脱敏形态（只保留审阅所需字段，**不带** image / audio / replyTo） */
export interface ScrubbedMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 毫秒时间戳 */
  at: number;
  /**
   * 以下是**回复质量审阅真正要看的四个维度**（2026-09-20 补齐），只对 assistant 生效。
   *
   * 为什么在这里补而不是在 reviewQueue 里另配一份：消息一旦进了 ScrubbedMessage，
   * 上层就已经拿不到原始字段了，要带上就只能在这一层显式搬（与 roleplaySessions 的
   * projectMessage 同一个坑：新字段不显式搬就会被静默丢掉）。
   *
   * 口径与 roleplaySessions 完全一致：**只认白名单取值**
   * （布尔 / 已知枚举 / 长度受限的模型名），旧的 / 没传的**一律空着**
   * （=「不知道」），绝不用默认值伪造成「快照值」。
   */
  viaUnlimited?: boolean;
  model?: string;
  style?: 'classic' | 'immersive';
  incomplete?: boolean;
}

export interface ScrubMessagesResult {
  messages: ScrubbedMessage[];
  hits: Record<string, number>;
  /** 被丢弃的附件数量（图片 / 语音），只记数量，不进队列 */
  droppedAttachments: number;
}

/**
 * 批量脱敏消息。
 *
 * 设计取舍：附件（image / audio 的 base64）**直接丢弃、只记数量**，不脱敏后保留。
 * 图片内容无法用正则洗（重识别风险最高的就是画面本身），且单张 base64 动辄几百 KB，
 * 灌进队列文件既危险又膨胀。
 */
/**
 * 时间戳归一化：Date / 数字（epoch 毫秒）/ ISO 字符串 三种形态都要认。
 *
 * 为什么必须显式认数字（2026-09-20 修）：剧情链路的 `timestamp` 落盘就是**数字**
 * （`roleplaySessions` 存的是 epoch 毫秒），而老实现只写 `new Date(String(v))`
 * `new Date('1789712288033')` 是 Invalid Date，于是**剧情的每一条消息时间都变成 0**：
 * 审阅队列里剧情的 startedAt 全是 0、每条 offsetMs 都是 0（「AI 这条回了多久」直接没了），
 * 而聊一聊用的是 ISO 字符串、一直正常，两边的表现不一致正是这条 bug 藏了这么久的原因。
 * 数字字符串（如 '1789712288033'）也一并按 epoch 毫秒认，避免上游换了序列化形态又静默归零。
 */
function toMs(v: unknown): number {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) && t > 0 ? t : 0;
  }
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return 0;
    // 纯数字串 = epoch 毫秒（长度 10 位以上才可能是毫秒；短数字串当成无意义输入）
    if (/^\d{10,}$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

export function scrubMessages(input: unknown): ScrubMessagesResult {
  const hits: Record<string, number> = {};
  const messages: ScrubbedMessage[] = [];
  let droppedAttachments = 0;

  if (!Array.isArray(input)) return { messages, hits, droppedAttachments };

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as {
      role?: unknown; content?: unknown; timestamp?: unknown; image?: unknown; audio?: unknown;
      viaUnlimited?: unknown; model?: unknown; style?: unknown; incomplete?: unknown;
    };
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.image || m.audio) droppedAttachments += 1;

    const { text, hits: h } = scrubText(m.content);
    for (const [k, v] of Object.entries(h)) hits[k] = (hits[k] || 0) + v;

    const msg: ScrubbedMessage = { role: m.role, content: text, at: toMs(m.timestamp) };
    if (m.role === 'assistant') {
      // 四个审阅维度：白名单取值，别的一律当「没记录」（见 ScrubbedMessage 的注释）
      if (typeof m.viaUnlimited === 'boolean') msg.viaUnlimited = m.viaUnlimited;
      if (typeof m.model === 'string' && m.model) msg.model = m.model.slice(0, 80);
      if (m.style === 'classic' || m.style === 'immersive') msg.style = m.style;
      if (typeof m.incomplete === 'boolean') msg.incomplete = m.incomplete;
    }
    messages.push(msg);
  }

  return { messages, hits, droppedAttachments };
}

/** 供审阅界面展示的「这次洗掉了什么」摘要，如「手机号×2、姓名×1」 */
export function describeHits(hits: Record<string, number>): string[] {
  return Object.entries(hits)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}×${n}`);
}

export default { scrubText, scrubMessages, describeHits };
