// 内置剧本封面：图片属于「大体积资源」（.gitignore 里的 src/wenyou/assets/），不随仓库分发。
// 所以这里用 import.meta.glob 收集而不是静态 import：本机有图就用图；干净检出 / CI 没有图时
// 解析成空串，卡片走「无封面」样式，npm run build:prod 在没有本机资源的机器上也成立。
const coverFiles = import.meta.glob('../assets/cover-*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

// 内置剧本的封面图，按剧本 id 索引；自定义剧本无内置封面，卡片按「无封面」样式呈现
export const covers: Record<string, string> = Object.fromEntries(
  ['wasteland', 'book', 'officialdom', 'spy', 'xian', 'wuxia', 'scifi', 'voyage', 'sanguo', 'liyuan']
    .map(id => [id, coverFiles[`../assets/cover-${id}.webp`] ?? '']),
)
