/**
 * 首页底部「推广类」浮层的排队规则（2026-09-21 真机走查 F4 修复）
 *
 * 背景：手机首屏曾经**同时**堆出多个底部浮层——安装/保存卡（`InstallAppBanner`，自带皮肤预览行）
 * 与今日打卡条（`MoodRewardBanner`）竖着叠在一起，再加上全局的隐私同意横幅（`PrivacyBanner`，
 * fixed bottom-0）和顶部/中部其他条，互相压住对方的正文（截图 `temp/bsk-qa/01-home-mobile.png`）。
 *
 * 规则：推广浮层**同屏最多一条**，优先级 今日打卡 > 安装/保存。
 * - 打卡条被用户关掉后（`moodBannerSeen` 置真），安装条自然接替，不会「排队卡死」。
 * - 隐私同意横幅**不参与**排队：它是合规提示，任何时候都要可见；推广浮层改为叠在它**上方**
 *   （由 Home 用 store 里的 `privacyBannerH` 抬 `bottom` 偏移），谁都不压谁。
 *
 * 抽成纯函数是为了能单测（见 `test/unit/bottomPromo.test.ts`）——之前这段优先级直接写在 JSX 里，
 * 既测不到、也没人说得清「到底几条能同时出现」。
 */

export interface BottomPromoInput {
  /** 安装/保存提示是否具备展示条件（usePwaInstall 的 toastEligible && 本次会话未关） */
  toastVisible: boolean;
  /** 今天还没打卡（登录用户才有） */
  moodEligible: boolean;
  /** 打卡条本次会话已被用户关掉 */
  moodBannerSeen: boolean;
}

export interface BottomPromoPlan {
  showMoodBanner: boolean;
  showInstallBanner: boolean;
}

export function pickBottomPromo({ toastVisible, moodEligible, moodBannerSeen }: BottomPromoInput): BottomPromoPlan {
  const showMoodBanner = moodEligible && !moodBannerSeen;
  return {
    showMoodBanner,
    // 打卡条优先；它不在时安装条才上场（两者永不同屏）
    showInstallBanner: toastVisible && !showMoodBanner,
  };
}
