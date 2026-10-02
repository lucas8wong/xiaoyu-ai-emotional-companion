/**
 * 记忆去重工具（轻量、无依赖）
 * 用于「长期记忆（用户事实）」与「成长记忆（关系/印象）」之间的跨块去重，
 * 以及成长记忆内部的去重：中文按字二元组 + Jaccard，英文按字符，归一化后比对。
 * 说明：这是「字符级」相似度，能抓大部分明显重复；语义级同义不同句需要 embedding（本文件不引入）。
 */

/** 归一化：小写、去空白/标点（保留中日韩字符与数字字母） */
export function normalizeForDedupe(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
     
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]/gu, '');
}

/** 取 n 元字符碎片（中文场景 n=2 即二元组） */
function shingles(s: string, n = 2): Set<string> {
  const set = new Set<string>();
  const len = s.length;
  if (len === 0) return set;
  if (len <= n) { set.add(s); return set; }
  for (let i = 0; i <= len - n; i++) set.add(s.slice(i, i + n));
  return set;
}

/** 最长公共子串长度（短文本 O(n*m)，够用） */
function longestCommonSubstrLen(a: string, b: string): number {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return 0;
  const dp = new Array(m + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= n; i++) {
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev + 1;
        if (dp[j] > best) best = dp[j];
      } else {
        dp[j] = 0;
      }
      prev = temp;
    }
  }
  return best;
}

/**
 * 原始字面相似度（0~1），`isSimilar` 的连续量版本。
 *
 * 与布尔版同一套算法（字二元组 Jaccard + 最长公共子串兜底），但不设阈值：
 * 「重复了多少」是连续量，应由调用方按档位决定何时算重复
 * （见 `api/services/repeatRefund.ts` 的重复度打分）。两个信号取 max：
 *   · Jaccard，整体词汇重合度；
 *   · 最长公共子串 / 较短串长度，抓「整段照抄但两端有增删」与短文本整句相同。
 */
export function lexicalSimilarity(a: string, b: string): number {
  const na = normalizeForDedupe(a);
  const nb = normalizeForDedupe(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = shingles(na, 2);
  const B = shingles(nb, 2);
  let jac = 0;
  if (A.size && B.size) {
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    jac = inter / (A.size + B.size - inter);
  }
  const lcs = longestCommonSubstrLen(na, nb) / Math.min(na.length, nb.length);
  return Math.max(jac, lcs);
}

/** Jaccard + 最长公共子串兜底；阈值默认 0.4 */
export function isSimilar(a: string, b: string, threshold = 0.4): boolean {
  const na = normalizeForDedupe(a);
  const nb = normalizeForDedupe(b);
  const A = shingles(na, 2);
  const B = shingles(nb, 2);
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  if (jaccard >= threshold) return true;
  // 长公共子串兜底：≥3 个连续相同字符视为重复（抓同一事实的轻微措辞差异）
  return longestCommonSubstrLen(na, nb) >= 3;
}

/**
 * 候选文本是否与 existing 中任一条「重复」。
 * 先做精确/包含匹配，再做字符级相似；命中即认为重复。
 */
export function dedupeAgainst(existing: string[], candidate: string): boolean {
  const c = normalizeForDedupe(candidate || '');
  if (!c) return false;
  return (existing || []).some(e => {
    const en = normalizeForDedupe(e);
    if (!en) return false;
    if (en === c || en.includes(c) || c.includes(en)) return true;
    return isSimilar(e, candidate);
  });
}

/**
 * 从 candidates 中剔除与 existing 重复的那些。
 */
export function filterDuplicates(existing: string[], candidates: string[]): string[] {
  return (candidates || []).filter(c => !dedupeAgainst(existing, c));
}
