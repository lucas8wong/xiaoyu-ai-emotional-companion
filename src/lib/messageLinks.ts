/**
 * 聊一聊正文里的「链接」识别（纯逻辑，2026-10-03 从 ChatPage.renderMessageText 抽出）
 *
 * 为什么抽出来：原来这段识别写在 ChatPage 里（还要出 React 节点、拼 JSX），单测够不到；
 * 而规则本身是纯字符串逻辑（裸域名、邮箱排除、尾随标点剥离、中文路径），必须能被
 * test/unit 钉死，2026-10-03 用户实测的 404 就是从这条规则里漏出去的。
 *
 * ⚠️ 2026-10-03 修（用户实测「点开显示网页不存在」）：
 *   旧字符类把 CJK（\u4e00-\u9fff）排除在路径之外，于是中文路径的链接
 *   "https://baike.baidu.com/item/心动的信号第九季/66939408" 会被截成
 *   "https://baike.baidu.com/item/"，浏览器打开落到百度百科 404
 *   「抱歉，您所访问的页面不存在…」。
 *   现在路径允许 CJK（与 linkifyjs、微信同一口径），只在空白、引号、中英文句读处断开。
 *   代价：模型若把中文**紧贴**链接尾且不加任何分隔（…/123这个页面），会被一并吞进 URL
 *   这是中文无词间分隔导致的固有歧义，标准链接识别器同样如此，接受；
 *   有空格或标点（，。）时不受影响，模型正常输出都会带。
 */

export interface MessageLinkMatch {
  /** 正则命中的整段原文（含被剥离的尾随标点）；推进游标用 */
  raw: string;
  /** 去掉尾随标点后的 URL 文本（无协议时不含 https://） */
  url: string;
  /** 可点击的绝对地址；空串 = 不当链接（按原样文本输出） */
  href: string;
  /** 被剥离的尾随标点，原样补回正文 */
  tail: string;
  /** 在入参文本中的起始下标 */
  index: number;
}

// 允许路径含 CJK（中文站点：百度百科 /item/心动的信号第九季/66939408、搜狗等），
// 只在中英文空白、引号、句读与成对书名/引号处断开。
const URL_RE = /(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>"'，。！？；：、（）【】「」『』《》〈〉“”‘’—…]*)?/gi;

// 尾随标点：留给正文（半角括号/句点/逗号等 URL 里允许但不该吃掉）
const TRAIL_RE = /[.,;:!?)\]}>"']+$/;

/** 扫出正文里的所有链接；无链接返回空数组。非卡片项 href 为空串，由调用方原样输出 raw。 */
export function findMessageLinks(text: string): MessageLinkMatch[] {
  const out: MessageLinkMatch[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) {
    // 邮箱里的域名（user@example.com）不算链接
    if (m.index > 0 && text[m.index - 1] === '@') continue;
    const raw = m[0];
    let url = raw;
    const trail = url.match(TRAIL_RE);
    let tail = '';
    if (trail) { tail = trail[0]; url = url.slice(0, -tail.length); }
    // 裸链接（无协议）要成卡片需带路径 或 www. 开头；否则当作普通文本，避免误判文件名/版本号
    const hasScheme = /^https?:\/\//i.test(url);
    const isCard = !!url && (hasScheme || /^www\./i.test(url) || url.includes('/'));
    out.push({ raw, url, href: isCard ? (hasScheme ? url : 'https://' + url) : '', tail, index: m.index });
  }
  return out;
}
