/**
 * 「地区语气」进入页面时一次性、可关闭的轻提示（聊一聊 / 理一理共用）
 * 触发：用户从未主动设过地区（cure_region_set 未置位）、且从未关闭过（cure_region_nudge_seen 未置位）
 * 渲染：复用 RegionNudgeCard（点「选地区味道」内联展开「地区语气 + 语气程度」选择器）
 */
import { useEffect, useState } from 'react';
import RegionNudgeCard from './RegionNudgeCard';

export default function EntryRegionNudge({ name }: { name?: string } = {}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      const set = localStorage.getItem('cure_region_set') === '1';
      const seen = localStorage.getItem('cure_region_nudge_seen') === '1';
      if (!set && !seen) setShow(true);
    } catch { /* 忽略 */ }
  }, []);

  if (!show) return null;
  return <RegionNudgeCard onClose={() => setShow(false)} name={name} />;
}
