import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBottomPromo } from '../../src/lib/bottomPromo';

/**
 * 回归背景（2026-09-21 真机走查 F4）：手机首屏曾经**同时**出现安装/保存卡 + 今日打卡条
 * （再加全局隐私同意横幅），几条浮层竖着叠在一起互相压住正文（`temp/bsk-qa/01-home-mobile.png`）。
 *
 * 这里钉住排队规则：推广浮层同屏最多一条，优先级 今日打卡 > 安装/保存；
 * 并且「关掉打卡条之后安装条要能接替」，不能排队卡死。
 */

test('底部浮层排队：打卡与安装都具备条件 → 只出打卡（安装让位）', () => {
  assert.deepEqual(
    pickBottomPromo({ toastVisible: true, moodEligible: true, moodBannerSeen: false }),
    { showMoodBanner: true, showInstallBanner: false },
  );
});

test('底部浮层排队：用户关掉打卡条之后 → 安装条接替出现（不排队卡死）', () => {
  assert.deepEqual(
    pickBottomPromo({ toastVisible: true, moodEligible: true, moodBannerSeen: true }),
    { showMoodBanner: false, showInstallBanner: true },
  );
});

test('底部浮层排队：只有安装具备条件 / 今天已打卡 → 行为与修复前一致', () => {
  // 未登录或今天已打卡（moodEligible=false），只有安装提示
  assert.deepEqual(
    pickBottomPromo({ toastVisible: true, moodEligible: false, moodBannerSeen: false }),
    { showMoodBanner: false, showInstallBanner: true },
  );
  // 已打卡但本次会话标记还在：仍只有安装条
  assert.deepEqual(
    pickBottomPromo({ toastVisible: true, moodEligible: false, moodBannerSeen: true }),
    { showMoodBanner: false, showInstallBanner: true },
  );
});

test('底部浮层排队：都不具备条件 → 容器不渲染（Home 里靠这两个布尔决定整块浮层）', () => {
  assert.deepEqual(
    pickBottomPromo({ toastVisible: false, moodEligible: false, moodBannerSeen: false }),
    { showMoodBanner: false, showInstallBanner: false },
  );
  assert.deepEqual(
    pickBottomPromo({ toastVisible: false, moodEligible: true, moodBannerSeen: true }),
    { showMoodBanner: false, showInstallBanner: false },
  );
});

test('底部浮层排队：遍历全部输入组合，任何情况下都不得同屏两条（F4 的守卫）', () => {
  for (const toastVisible of [true, false]) {
    for (const moodEligible of [true, false]) {
      for (const moodBannerSeen of [true, false]) {
        const plan = pickBottomPromo({ toastVisible, moodEligible, moodBannerSeen });
        assert.equal(
          plan.showMoodBanner && plan.showInstallBanner,
          false,
          `同屏两条浮层：${JSON.stringify({ toastVisible, moodEligible, moodBannerSeen })} → ${JSON.stringify(plan)}`,
        );
      }
    }
  }
});
