/**
 * 皮肤上下文：当前皮肤 + 切换入口。
 * 挂载时读取 localStorage 并立即写 <html data-skin>，避免首屏闪一下默认色。
 * 同时承载「界面外观 → 卡片透明度」（--card-bg-alpha），默认中度透明。
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { applySkin, getStoredSkin, skinById, getAllSkins, setDynamicSkins, writeDynamicSkinsCache, applyCardBgAlpha, getStoredCardBgAlpha, applyBgWash, getStoredBgWash, type SkinId, type SkinMeta, type CardBgAlpha, type BgWash } from '../lib/skin';
import { reportSkin } from '../services/api';

interface SkinContextValue {
  skin: SkinId;
  setSkin: (id: SkinId) => void;
  meta: SkinMeta;
  /** 当前可选皮肤列表（内置静态 + 运行时从 manifest 加载的动态皮肤） */
  skins: SkinMeta[];
  /** 白板卡片背景透明度（0=全透，1=不透；默认 0.8 中度透明） */
  cardBgAlpha: CardBgAlpha;
  setCardBgAlpha: (alpha: CardBgAlpha) => void;
  /** 氛围背景深浅（0=背景图明显/深，1=全浅/背景几乎不可见；默认 0.72，仅深色背景皮肤如星空生效） */
  bgWash: BgWash;
  setBgWash: (wash: BgWash) => void;
}

const SkinContext = createContext<SkinContextValue>({
  skin: 'healing',
  setSkin: () => {},
  meta: skinById('healing'),
  skins: getAllSkins(),
  cardBgAlpha: 0.8,
  setCardBgAlpha: () => {},
  bgWash: 0.72,
  setBgWash: () => {},
});

export function SkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkinState] = useState<SkinId>(() => {
    const s = getStoredSkin();
    applySkin(s);
    return s;
  });
  const [cardBgAlpha, setCardBgAlphaState] = useState<CardBgAlpha>(() => {
    const a = getStoredCardBgAlpha();
    applyCardBgAlpha(a);
    return a;
  });
  const [bgWash, setBgWashState] = useState<BgWash>(() => getStoredBgWash(skin));
  const [, setDynamicSkinsTick] = useState(0);

  // 切换后同步 <html data-skin> + localStorage；并让深浅状态跟随当前皮肤
  useEffect(() => { applySkin(skin); setBgWashState(getStoredBgWash(skin)); }, [skin]);
  // 首次加载 + 切换皮肤 → 上报当前皮肤（供控制台统计用户皮肤使用）；fire-and-forget
  useEffect(() => { reportSkin(skin); }, [skin]);
  // 切换后同步 <html style --card-bg-alpha> + localStorage
  useEffect(() => { applyCardBgAlpha(cardBgAlpha); }, [cardBgAlpha]);

  // 运行时加载管理员生成的动态皮肤（public/skins/manifest.json，生成即出现、免改源码）
  useEffect(() => {
    let cancelled = false;
    fetch('/skins/manifest.json?v=1') // ?v=1 绕过浏览器/Cloudflare 对旧清单的 7 天缓存，保证新增皮肤即时生效
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (cancelled) return;
        const arr = Array.isArray(list) ? (list as SkinMeta[]) : [];
        setDynamicSkins(arr);
        writeDynamicSkinsCache(arr);
        setDynamicSkinsTick((n) => n + 1);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const setSkin = useCallback((id: SkinId) => setSkinState(id), []);
  const setCardBgAlpha = useCallback((a: CardBgAlpha) => setCardBgAlphaState(a), []);
  const setBgWash = useCallback((w: BgWash) => { setBgWashState(w); applyBgWash(w, skin); }, [skin]);

  const skins = getAllSkins();

  return (
    <SkinContext.Provider value={{ skin, setSkin, meta: skinById(skin), skins, cardBgAlpha, setCardBgAlpha, bgWash, setBgWash }}>
      {children}
    </SkinContext.Provider>
  );
}

export function useSkin() {
  return useContext(SkinContext);
}
