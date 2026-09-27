/**
 * 首页底部 CTA 的「开始」三选一弹窗：聊一聊 / 理一理 / 角色剧情扮演
 * 通用组件，三语言；复用各功能入口的标题与描述，保持文案一致
 */

import { X, MessageCircleHeart, Compass, Drama } from 'lucide-react';
import { t } from '../i18n';
import { useSkin } from './SkinProvider';
import Modal from './ui/Modal';

interface StartModalProps {
  open: boolean;
  onChat: () => void;
  onStructure: () => void;
  onRoleplay: () => void;
  onClose: () => void;
}

type FeatureKey = 'chat' | 'structure' | 'story';

export default function StartModal({ open, onChat, onStructure, onRoleplay, onClose }: StartModalProps) {
  const { meta } = useSkin();
  if (!open) return null;

  const opts: Array<{ icon: any; metaKey: FeatureKey; title: string; desc: string; onClick: () => void }> = [
    { icon: MessageCircleHeart, metaKey: 'chat', title: t('entryChatTitle'), desc: t('entryChatDesc'), onClick: onChat },
    { icon: Compass, metaKey: 'structure', title: t('entryStructureTitle'), desc: t('entryStructureDesc'), onClick: onStructure },
    { icon: Drama, metaKey: 'story', title: t('roleplayTitle'), desc: t('roleplaySub'), onClick: onRoleplay },
  ];

  return (
    <Modal open={open} onClose={onClose} width="max-w-sm" padding="p-5">
        <h2 className="text-lg font-bold text-gray-800 text-center mb-5">{t('startAsk')}</h2>
        <div className="space-y-3">
          {opts.map(o => {
            const Icon = o.icon;
            // 入口图标优先用皮肤小图（≈240px），无则回退大图
            const img = (meta as unknown as Record<string, string>)[o.metaKey + 'Sm'] || meta[o.metaKey];
            return (
              <button key={o.title} onClick={o.onClick} className="w-full flex items-center gap-3 rounded-xl border-2 border-gray-200 bg-transparent px-4 py-3 text-left hover:border-primary hover:bg-primary-lighter transition-all">
                <span className={"w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 " + (img ? '' : 'bg-primary-lighter text-primary')}>
                  {img ? <img src={img} alt="" loading="lazy" className="w-full h-full object-cover" /> : <Icon className="w-5 h-5" />}
                </span>
                <span className="flex-1">
                  <span className="block text-[15px] font-semibold text-gray-800">{o.title}</span>
                  <span className="block text-[11px] sm:text-xs text-gray-700 mt-0.5 leading-snug">{o.desc}</span>
                </span>
                <span className="text-primary text-lg flex-shrink-0">→</span>
              </button>
            );
          })}
        </div>
    </Modal>
  );
}
