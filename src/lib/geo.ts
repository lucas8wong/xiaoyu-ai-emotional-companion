/**
 * 访问者地理信息（country / region / 是否中国大陆）
 * - 单例缓存 + 仅一次请求，多个组件共享，避免重复拉取
 * - 拿不到/异常时按「非大陆」处理（不阻断正常用户）
 * - ⚠️ 支付侧与地区无关（自动到账只有 Stripe；微信收款码是人工兜底、所有地区一样展示），
 *   本模块当前无 UI 调用点，保留给未来的「按地区展示不同内容」需求
 *   （后端 `GET /api/geo/me` 仍在服务端可用）
 */

import { useEffect, useState } from 'react';
import { getMyGeo } from '../services/api';

export interface VisitorGeo {
  country: string;
  region: string;
  isMainland: boolean;
}

let cache: VisitorGeo | null = null;
let inflight: Promise<VisitorGeo> | null = null;

export function loadVisitorGeo(): Promise<VisitorGeo> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = getMyGeo()
      .then((r) => {
        cache = {
          country: r.data?.country ?? '',
          region: r.data?.region ?? '',
          isMainland: !!r.data?.isMainland,
        };
        return cache;
      })
      .catch(() => {
        cache = { country: '', region: '', isMainland: false };
        return cache;
      });
  }
  return inflight;
}

/** React hook：读取访问者地理信息（初次返回缓存或默认值，异步拉取后更新） */
export function useVisitorGeo(): VisitorGeo {
  const [geo, setGeo] = useState<VisitorGeo>(cache ?? { country: '', region: '', isMainland: false });
  useEffect(() => {
    let alive = true;
    loadVisitorGeo().then((g) => {
      if (alive) setGeo(g);
    });
    return () => {
      alive = false;
    };
  }, []);
  return geo;
}
