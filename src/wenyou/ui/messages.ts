/** Centralized user-facing strings — single source of truth for i18n and consistency. */

export const msg = {
  /** Error: no API config found */
  noApiConfig: '未找到 API 配置，请回到卷首重新设置',

  /** Import error prefix */
  importFailed: '剧本导入失败',

  /** Clipboard copy failed */
  copyFailed: '复制失败：浏览器拒绝了剪贴板访问，请手动选择文本复制',

  /** Lightbox / art thumbnail tooltip */
  clickToEnlarge: '点击看全图',

  /** Lightbox aria-label */
  viewLargeImage: '查看大图',

  /** Node art thumbnail aria-label */
  viewNodeArt: '查看此节点配图',
} as const
