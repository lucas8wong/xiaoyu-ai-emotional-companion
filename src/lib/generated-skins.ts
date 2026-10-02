import type { SkinMeta } from './skin';

/**
 * 管理员生成的皮肤（静态化）清单，由皮肤生成器 / scripts/staticize-skins.mts 写入。
 * 生成后需重新构建前端（npm run build:prod），皮肤即作为静态资源随包发布、首帧即命中。
 * 手写/品牌皮肤（default/healing/zen/star/candy）不在此列。
 */
export const GENERATED_STATIC_SKINS: SkinMeta[] = [
  
];
