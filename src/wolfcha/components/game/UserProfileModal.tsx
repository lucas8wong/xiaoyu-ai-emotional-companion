"use client";

/**
 * 账号面板（小愈版）
 *
 * ⚠️ 这里是**重写**，不是上游原文件：上游这个弹窗里除了「邮箱 / 剩余次数 / 改密码 / 退出登录」，
 * 其余全是 **wolfcha 自己的东西**——自带 API Key（Zenmux / 百炼 Dashscope / TokenDance / MiniMax）、
 * 模型选择器、TokenPay 充值、WatchaPay 购买、兑换码、邀请码、新春活动额度。
 * 那些功能在小愈里**根本不可用**（`/api/validate-key`、`/api/tokenpay/balance`、
 * `/api/credits/{redeem,referral,spring-login-bonus}` 在 `api/` 里都不存在），
 * 而且会把上游品牌露给用户，故整块删除；小愈的额度与充值走自己的会员体系。
 */
import { UserCircle, SignOut, Password } from "@phosphor-icons/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { useTranslations } from "next-intl";

interface UserProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email?: string | null;
  credits?: number | null;
  onChangePassword: () => void;
  onSignOut: () => void | Promise<void>;
}

export function UserProfileModal({
  open,
  onOpenChange,
  email,
  credits,
  onChangePassword,
  onSignOut,
}: UserProfileModalProps) {
  const t = useTranslations();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[var(--text-primary)]">
            <UserCircle size={18} weight="duotone" />
            {t("userProfile.title")}
          </DialogTitle>
          <DialogDescription className="text-[var(--text-muted)]">
            {t("userProfile.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border-2 border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--text-muted)]">{t("userProfile.fields.email")}</span>
              <span className="text-sm text-[var(--text-primary)] truncate max-w-[60%]">
                {email ?? t("userProfile.empty")}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--text-muted)]">{t("userProfile.fields.credits")}</span>
              <span className="text-sm text-[var(--color-gold)] font-medium">
                {credits ?? 0}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              className="justify-start gap-2"
              onClick={() => {
                onOpenChange(false);
                onChangePassword();
              }}
            >
              <Password size={16} />
              {t("userProfile.actions.changePassword")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="justify-start gap-2 text-red-500 hover:text-red-600"
              onClick={() => {
                onOpenChange(false);
                void onSignOut();
              }}
            >
              <SignOut size={16} />
              {t("userProfile.actions.signOut")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
