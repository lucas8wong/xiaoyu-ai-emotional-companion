/**
 * 界面皮肤槽位目录。
 * 每套皮肤由这些图片位组成；生成器按槽位写英文提示词、调 Seedream 出图并落盘。
 * key 与 src/lib/skin.ts 的 SkinMeta 属性名一一对应。
 * 注意：Seedream 5.0 要求图片总像素 ≥ 3,686,400（至少 1920×1920），这里给出的尺寸均已合规。
 */
export type SkinSlotKind = 'scene' | 'illustration' | 'avatar' | 'logo' | 'icon';
export type SkinAspect = 'wide' | 'portrait' | 'square' | 'logo';

export interface SkinSlot {
  key: string;         // 与 SkinMeta 属性名一致
  kind: SkinSlotKind;
  aspect: SkinAspect;
  /** Seedream size 参数（WxH），已满足最小像素要求 */
  size: string;
  /** 槽位英文名（用于提示词） */
  titleEn: string;
  /** 作用说明（中文，供管理员了解） */
  desc: string;
}

export const SKIN_SLOTS: SkinSlot[] = [
  { key: 'bg', kind: 'scene', aspect: 'wide', size: '2560x1440', titleEn: 'atmosphere background', desc: '全屏氛围背景（宽屏）' },
  { key: 'bgPortrait', kind: 'scene', aspect: 'portrait', size: '1440x2560', titleEn: 'atmosphere background', desc: '竖版氛围背景（手机端/分享卡）' },
  { key: 'hero', kind: 'scene', aspect: 'wide', size: '2560x1440', titleEn: 'hero main scene', desc: '首页 Hero 主场景' },
  { key: 'chat', kind: 'illustration', aspect: 'square', size: '1920x1920', titleEn: 'chat feature illustration', desc: '回忆胶囊/对话功能插画' },
  { key: 'structure', kind: 'illustration', aspect: 'square', size: '1920x1920', titleEn: 'structure feature illustration', desc: '理一理功能插画' },
  { key: 'story', kind: 'illustration', aspect: 'square', size: '1920x1920', titleEn: 'healing story illustration', desc: '疗愈故事插画' },
  { key: 'wordmark', kind: 'logo', aspect: 'logo', size: '2560x1440', titleEn: 'brand wordmark for "Xiaoyu"', desc: '品牌字标（Xiaoyu）' },
  { key: 'heart', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'brand heart mark', desc: '品牌心形 mark' },
  { key: 'favicon', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'app icon', desc: '浏览器/应用图标（favicon）' },
  { key: 'companion', kind: 'avatar', aspect: 'square', size: '1920x1920', titleEn: 'AI companion avatar', desc: 'AI 陪伴头像' },
  { key: 'membership', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'membership mark', desc: '会员中心标' },
  { key: 'modeHug', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'scenario card art: being held', desc: '场景卡插画：被接住（2026-09-23 起不再代表档位，仅作首页场景卡配图）' },
  { key: 'modeAlly', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'scenario card art: side by side', desc: '场景卡插画：并肩同行' },
  { key: 'modeClarify', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'scenario card art: untangling', desc: '场景卡插画：理一理' },
  { key: 'modeLight', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'scenario card art: a lighter view', desc: '场景卡插画：换轻一点的角度' },
  { key: 'modeObjective', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'scenario card art: a steadier view', desc: '场景卡插画：看得更客观' },
  { key: 'feedback', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'feedback icon', desc: '意见反馈图标' },
  { key: 'planFree', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'free plan icon', desc: '会员档·免费图标' },
  { key: 'planPlus', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'plus plan icon', desc: '会员档·Plus 图标' },
  { key: 'planPro', kind: 'icon', aspect: 'square', size: '1920x1920', titleEn: 'pro plan icon', desc: '会员档·Pro 图标' },
  { key: 'preview', kind: 'scene', aspect: 'wide', size: '2560x1440', titleEn: 'skin preview thumbnail', desc: '皮肤选择器缩略图' },
];

export function slotByKey(key: string): SkinSlot | undefined {
  return SKIN_SLOTS.find((s) => s.key === key);
}
