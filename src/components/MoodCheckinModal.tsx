/**
 * 心情打卡（独立弹窗，从「我的」独立出来）
 */
import { X, CalendarDays } from 'lucide-react';
import MoodCheckinView from './MoodCheckinView';
import { t } from '../i18n';
import Modal from './ui/Modal';

interface MoodCheckinModalProps {
  open: boolean;
  onClose: () => void;
}

export default function MoodCheckinModal({ open, onClose }: MoodCheckinModalProps) {
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose}>
        <div className="text-center mb-5">
          <div className="w-12 h-12 bg-primary-soft rounded-full flex items-center justify-center mx-auto mb-2">
            <CalendarDays className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-xl font-bold text-gray-800">{t('profileMoodModule')}</h2>
          <p className="text-sm text-ink-soft mt-1">{t('profileTodayMood')}</p>
        </div>
        <MoodCheckinView />
    </Modal>
  );
}
