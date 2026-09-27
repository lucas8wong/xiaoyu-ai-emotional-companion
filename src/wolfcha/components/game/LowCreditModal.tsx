"use client";

import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { LinkSimple, CreditCard, Play } from "@phosphor-icons/react";

const LOW_CREDIT_THRESHOLD = 3;

interface LowCreditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credits: number;
  onStartGame: () => void;
}

export function LowCreditModal({
  open,
  onOpenChange,
  credits,
  onStartGame,
}: LowCreditModalProps) {
  const t = useTranslations("lowCreditModal");

  const handleStartGame = () => {
    onOpenChange(false);
    onStartGame();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[var(--text-primary)]">
            {t("title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="relative rounded-xl border border-[var(--color-gold)]/30 bg-gradient-to-b from-[var(--color-gold)]/5 to-transparent p-5 text-center overflow-hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,var(--color-gold)_0%,transparent_50%)] opacity-10" />
            <p className="relative text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
              {t("currentCredits")}
            </p>
            <p className="relative mt-2 text-5xl font-bold text-[var(--color-gold)]">
              {credits}
            </p>
            <p className="relative mt-1 text-sm text-[var(--text-secondary)]">
              {t("unit")}
            </p>
          </div>

          <p className="text-sm text-[var(--text-secondary)] leading-relaxed text-center px-2">
            {null /* 移植适配：移除上游「求赞助」文案 */}
          </p>

          <div className="space-y-3 pt-1">

            <button
              type="button"
              onClick={handleStartGame}
              className="w-full py-2 text-sm text-[var(--text-muted)] hover:text-[var(--color-gold)] transition-colors flex items-center justify-center gap-2"
            >
              <Play size={16} />
              {credits === 0 ? t("startGameNoCredits") : t("startGame")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { LOW_CREDIT_THRESHOLD };
