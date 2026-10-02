"use client";

import { motion, AnimatePresence } from "framer-motion";
import { FingerprintSimple, Sparkle, Wrench, GearSix, UserCircle, DotsThreeOutlineVertical, UsersFour } from "@phosphor-icons/react";
import { WerewolfIcon } from "~/components/icons/FlatIcons";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom } from "jotai";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { DevPreset, DifficultyLevel, Role, StartGameOptions } from "~/types/game";
import { DevModeButton } from "~/components/DevTools";
import { GameSetupModal } from "~/components/game/GameSetupModal";
import { AccountModal } from "~/components/game/AccountModal";
import { UserProfileModal } from "~/components/game/UserProfileModal";
import { LowCreditModal, LOW_CREDIT_THRESHOLD } from "~/components/game/LowCreditModal";
import { CustomCharacterModal } from "~/components/game/CustomCharacterModal";
import { useCustomCharacters } from "~/hooks/useCustomCharacters";
import { useCredits, type ConsumeCreditResult } from "~/hooks/useCredits";
import { difficultyAtom, playerCountAtom, preferredRoleAtom } from "~/store/settings";
import { MODEL_ID } from "~/lib/model";

const CUSTOM_CHARACTER_SELECTION_STORAGE_KEY = "wolfcha_custom_character_selection";

function buildDefaultRoles(playerCount: number): Role[] {
  switch (playerCount) {
    case 8:
      return ["Werewolf", "Werewolf", "Werewolf", "Seer", "Witch", "Hunter", "Villager", "Villager"];
    case 9:
      return [
        "Werewolf",
        "Werewolf",
        "Werewolf",
        "Seer",
        "Witch",
        "Hunter",
        "Villager",
        "Villager",
        "Villager",
      ];
    case 11:
      return [
        "Werewolf",
        "Werewolf",
        "Werewolf",
        "WhiteWolfKing",
        "Seer",
        "Witch",
        "Hunter",
        "Guard",
        "Idiot",
        "Villager",
        "Villager",
      ];
    case 12:
      return [
        "Werewolf",
        "Werewolf",
        "Werewolf",
        "WhiteWolfKing",
        "Seer",
        "Witch",
        "Hunter",
        "Guard",
        "Idiot",
        "Villager",
        "Villager",
        "Villager",
      ];
    case 10:
    default:
      return [
        "Werewolf",
        "Werewolf",
        "WhiteWolfKing",
        "Seer",
        "Witch",
        "Hunter",
        "Guard",
        "Villager",
        "Villager",
        "Villager",
      ];
  }
}

function getRoleCountConfig(playerCount: number) {
  const werewolfCount = playerCount >= 11 ? 3 : 2;
  const whiteWolfKingCount = 1;
  const wolfCount = werewolfCount + whiteWolfKingCount;
  const guardCount = playerCount >= 10 ? 1 : 0;
  const idiotCount = playerCount >= 11 ? 1 : 0;
  const seerCount = 1;
  const witchCount = 1;
  const hunterCount = 1;
  const godCount = seerCount + witchCount + hunterCount + guardCount + idiotCount;
  const villagerCount = Math.max(0, playerCount - wolfCount - godCount);
  return {
    werewolfCount,
    whiteWolfKingCount,
    wolfCount,
    guardCount,
    seerCount,
    witchCount,
    hunterCount,
    idiotCount,
    villagerCount,
  };
}

interface WelcomeScreenProps {
  humanName: string;
  setHumanName: (name: string) => void;
  onStart: (options?: StartGameOptions) => void | Promise<void>;
  onAbort?: () => void;
  isLoading: boolean;
  isGenshinMode: boolean;
  onGenshinModeChange: (value: boolean) => void;
  isSpectatorMode: boolean;
  onSpectatorModeChange: (value: boolean) => void;
  bgmVolume: number;
  isSoundEnabled: boolean;
  isAutoAdvanceDialogueEnabled: boolean;
  onBgmVolumeChange: (value: number) => void;
  onSoundEnabledChange: (value: boolean) => void;
  onAutoAdvanceDialogueEnabledChange: (value: boolean) => void;
}

export function WelcomeScreen({
  humanName,
  setHumanName,
  onStart,
  onAbort,
  isLoading,
  isGenshinMode,
  onGenshinModeChange,
  isSpectatorMode,
  onSpectatorModeChange,
  bgmVolume,
  isSoundEnabled,
  isAutoAdvanceDialogueEnabled,
  onBgmVolumeChange,
  onSoundEnabledChange,
  onAutoAdvanceDialogueEnabledChange,
}: WelcomeScreenProps) {
  const t = useTranslations();
  const {
    user,
    session,
    credits,
    unlimited,
    gameEstimate,
    minStartTiao,
    lastSettlement,
    loading: creditsLoading,
    consumeCredit,
    completeGameStartRequest,
    hasPendingGameStartRequest,
    signOut,
    refreshDemoConfig,
  } = useCredits();
  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const sealButtonRef = useRef<HTMLButtonElement | null>(null);
  const isStartingRef = useRef(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isUserProfileOpen, setIsUserProfileOpen] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isCustomCharacterOpen, setIsCustomCharacterOpen] = useState(false);
  const [isLowCreditOpen, setIsLowCreditOpen] = useState(false);
  const selectionStorageKey = useMemo(() => {
    return user?.id
      ? `${CUSTOM_CHARACTER_SELECTION_STORAGE_KEY}:${user.id}`
      : CUSTOM_CHARACTER_SELECTION_STORAGE_KEY;
  }, [user?.id]);

  const readSelectionFromStorage = useCallback(() => {
    if (typeof window === "undefined") return new Set<string>();
    try {
      const raw = window.localStorage.getItem(selectionStorageKey);
      if (!raw) return new Set<string>();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set<string>();
      return new Set(parsed.filter((item): item is string => typeof item === "string"));
    } catch {
      return new Set<string>();
    }
  }, [selectionStorageKey]);

  const selectionStorageKeyRef = useRef<string | null>(null);
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<Set<string>>(() =>
    readSelectionFromStorage()
  );

  const customCharacters = useCustomCharacters(user);
  const [difficulty, setDifficulty] = useAtom(difficultyAtom);
  const [playerCount, setPlayerCount] = useAtom(playerCountAtom);
  const [preferredRole, setPreferredRole] = useAtom(preferredRoleAtom);

  useEffect(() => {
    selectionStorageKeyRef.current = selectionStorageKey;
    setSelectedCharacterIds(readSelectionFromStorage());
  }, [readSelectionFromStorage, selectionStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectionStorageKeyRef.current !== selectionStorageKey) return;
    const ids = Array.from(selectedCharacterIds);
    window.localStorage.setItem(selectionStorageKey, JSON.stringify(ids));
  }, [selectedCharacterIds, selectionStorageKey]);

  useEffect(() => {
    if (customCharacters.loading) return;
    const validIds = new Set(customCharacters.characters.map((char) => char.id));
    const filtered = new Set(
      Array.from(selectedCharacterIds).filter((id) => validIds.has(id))
    );
    if (filtered.size !== selectedCharacterIds.size) {
      setSelectedCharacterIds(filtered);
    }
  }, [customCharacters.characters, customCharacters.loading, selectedCharacterIds]);

  // 调试面板状态
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [isDevModeEnabled, setIsDevModeEnabled] = useState(false);
  const [isDevConsoleOpen, setIsDevConsoleOpen] = useState(false);
  const [devTab, setDevTab] = useState<"preset" | "roles">("preset");
  const [devPreset, setDevPreset] = useState<DevPreset | "">("");
  const showDevTools =
    process.env.NODE_ENV !== "production" && (process.env.NEXT_PUBLIC_SHOW_DEVTOOLS ?? "true") === "true";

  const roleOptions: Role[] = ["Villager", "Werewolf", "WhiteWolfKing", "Seer", "Witch", "Hunter", "Guard", "Idiot"];
  const roleLabels = useMemo<Record<Role, string>>(
    () => ({
      Villager: t("roles.villager"),
      Werewolf: t("roles.werewolf"),
      WhiteWolfKing: t("roles.whiteWolfKing"),
      Seer: t("roles.seer"),
      Witch: t("roles.witch"),
      Hunter: t("roles.hunter"),
      Guard: t("roles.guard"),
      Idiot: t("roles.idiot"),
    }),
    [t]
  );

  const [devRoleOverrideEnabled, setDevRoleOverrideEnabled] = useState(false);
  const [fixedRoles, setFixedRoles] = useState<(Role | "")[]>(() => buildDefaultRoles(10));

  useEffect(() => {
    setFixedRoles(buildDefaultRoles(playerCount));
  }, [playerCount]);

  const roleConfigValid = useMemo(() => {
    if (fixedRoles.length !== playerCount) return false;
    if (fixedRoles.some((r) => !r)) return false;

    const counts: Record<Role, number> = {
      Villager: 0,
      Werewolf: 0,
      Seer: 0,
      Witch: 0,
      Hunter: 0,
      Guard: 0,
      Idiot: 0,
      WhiteWolfKing: 0,
    };
    for (const r of fixedRoles) {
      counts[r as Role] += 1;
    }

    const expected = getRoleCountConfig(playerCount);
    return (
      counts.Werewolf === expected.werewolfCount &&
      counts.WhiteWolfKing === expected.whiteWolfKingCount &&
      counts.Seer === expected.seerCount &&
      counts.Witch === expected.witchCount &&
      counts.Hunter === expected.hunterCount &&
      counts.Guard === expected.guardCount &&
      counts.Idiot === expected.idiotCount &&
      counts.Villager === expected.villagerCount
    );
  }, [fixedRoles, playerCount]);

  const roleConfigHint = useMemo(() => {
    const expected = getRoleCountConfig(playerCount);
    const godLabel =
      expected.guardCount > 0 ? t("welcome.roleConfig.godLabelFull") : t("welcome.roleConfig.godLabelNoGuard");
    return t("welcome.roleConfig.hint", {
      wolfCount: expected.wolfCount,
      godLabel,
      villagerCount: expected.villagerCount,
    });
  }, [playerCount, t]);

  /**
   * ⚠️ 移植适配（非上游原样）：上游把 `!creditsLoading` 也当作开局的必要条件，
   * 而 `useCredits` 的 loading **初值是 true**、且在没有 user 时会提前 return 不予清除，
   * 于是它可能永久为 true → canConfirm 恒假 → **印章点了永远没反应**（实测用户反馈）。
   * 额度加载只是显示层的事，不该成为开局的闸门；真正的额度闸门在服务端
   * `/api/credits/consume`（还有每日次数限制），所以这里去掉这个条件。
   */
  const canConfirm = useMemo(() => {
    return !!humanName.trim() && !isLoading && !isTransitioning;
  }, [humanName, isLoading, isTransitioning]);

  const isAnyModalOpen =
    isSetupOpen ||
    isAccountOpen ||
    isUserProfileOpen ||
    isMobileMenuOpen ||
    isCustomCharacterOpen ||
    isLowCreditOpen ||
    isDevConsoleOpen;

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;

    if (typeof window === "undefined") return;
    if ("ontouchstart" in window) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let rafId: number | null = null;
    let lastX = 0;
    let lastY = 0;

    const update = () => {
      rafId = null;
      const xAxis = (window.innerWidth / 2 - lastX) / 60;
      const yAxis = (window.innerHeight / 2 - lastY) / 60;
      paper.style.setProperty("--wc-tilt-x", `${xAxis}`);
      paper.style.setProperty("--wc-tilt-y", `${yAxis}`);
    };

    const onMove = (e: MouseEvent) => {
      lastX = e.clientX;
      lastY = e.clientY;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(update);
    };

    const onLeave = () => {
      paper.style.setProperty("--wc-tilt-x", "0");
      paper.style.setProperty("--wc-tilt-y", "0");
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, []);

  const createParticles = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    for (let i = 0; i < 18; i += 1) {
      const particle = document.createElement("div");
      particle.className = "wc-particle";
      document.body.appendChild(particle);

      const size = Math.random() * 7 + 2;
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.left = `${centerX}px`;
      particle.style.top = `${centerY}px`;

      const angle = Math.random() * Math.PI * 2;
      const velocity = Math.random() * 90 + 40;
      const tx = Math.cos(angle) * velocity;
      const ty = Math.sin(angle) * velocity - 90;

      particle.animate(
        [
          { transform: "translate(0, 0) scale(1)", opacity: 1 },
          { transform: `translate(${tx}px, ${ty}px) scale(0)`, opacity: 0 },
        ],
        {
          duration: 900 + Math.random() * 450,
          easing: "cubic-bezier(0, .9, .57, 1)",
          fill: "forwards",
        }
      );

      window.setTimeout(() => particle.remove(), 1600);
    }
  };

  /**
   * 开局被额度拦住 → **统一额度门控**（2026-09-27 用户拍板 B：「注册才能玩」+ 拦截改成注册引导）。
   *
   * 为什么走事件而不是自己弹窗：小愈的额度用尽决策已经有**一处中央实现**（`xiaoyu:quota-exhausted`
   * → `Home.handleQuotaExhausted`）：游客→注册弹窗、已注册免费→「获取更多额度」（分享/反馈）、
   * Plus→会员升级。狼人杀自己再弹一套，就会与聊一聊/剧情出现两套口径（2026-09-05 那轮就是为了
   * 消灭这种分叉）。这里只负责：**告诉用户为什么开不了**（带真实数字）+ 把决策交出去。
   *
   * `isRegistered` 判据来自服务端 402 的 `registerHint`（= `quotaStore.isRegisteredAccount`），
   * 与免费档分档同源；若服务端没给（老版本），退回按"是否有 token"粗判，仅影响提示语措辞。
   */
  const openQuotaGateway = useCallback((opts?: { isGuest?: boolean; neededTiao?: number }) => {
    const need = opts?.neededTiao ?? minStartTiao ?? null;
    const cost = gameEstimate ?? null;
    // 文案只讲**这一次为什么不行**（用真实数字）；「注册后每天多少条」由注册弹窗自己按后端数字说明，
    // 避免把档位数字在狼人语料里再抄一遍（改 .env 会漂）。
    const key = opts?.isGuest === false ? 'welcome.toast.gameBlocked.member' : 'welcome.toast.gameBlocked.guest';
    toast.error(t('welcome.toast.gameBlocked.title') as string, {
      description: t(key, { need: need ?? '-', cost: cost ?? '-', remain: credits ?? 0 }) as string,
    });
    try { window.dispatchEvent(new CustomEvent('xiaoyu:quota-exhausted')); } catch { /* 忽略 */ }
  }, [credits, gameEstimate, minStartTiao, t]);

  const handleCreditFailure = (result?: ConsumeCreditResult) => {
    setIsTransitioning(false);
    onAbort?.();
    /**
     * 额度拦截（402 / `QUOTA_EXCEEDED`）≠ 开局失败：这两件事对用户是**完全不同的动作**
     * （前者去注册/获取额度/升级，后者是重试）。所以先按 code/status 分派，别一律报「开局请求未完成」。
     */
    const quotaBlocked =
      result?.status === 402 ||
      result?.status === 429 ||
      result?.code === 'QUOTA_EXCEEDED' ||
      result?.code === 'CHAT_QUOTA_EXCEEDED';
    if (quotaBlocked) {
      openQuotaGateway({ isGuest: result?.registerHint === true ? true : result?.registerHint === false ? false : undefined, neededTiao: result?.neededTiao });
      return;
    }
    const insufficientCredits =
      result?.status === 400 &&
      result.error?.toLowerCase().includes("insufficient") === true;
    if (!insufficientCredits) {
      toast.error(t("welcome.toast.startFail.title"), {
        description: t("welcome.toast.startFail.description"),
      });
      return;
    }
    setIsUserProfileOpen(true);
    toast.error(t("welcome.toast.creditFail.title"), { description: t("welcome.toast.creditFail.description") });
  };

  const buildStartOptions = (gameSessionId?: string | null): StartGameOptions => {
    const roles = devTab === "roles" && devRoleOverrideEnabled && roleConfigValid ? (fixedRoles as Role[]) : undefined;
    const preset = devTab === "preset" && devPreset ? (devPreset as DevPreset) : undefined;
    const selectedCustomChars = customCharacters.characters
      .filter(c => selectedCharacterIds.has(c.id))
      .map(c => ({
        id: c.id,
        display_name: c.display_name,
        gender: c.gender,
        age: c.age,
        mbti: c.mbti,
        basic_info: c.basic_info,
        style_label: c.style_label,
        avatar_seed: c.avatar_seed,
      }));

    return {
      fixedRoles: roles,
      devPreset: preset,
      difficulty,
      playerCount,
      gameSessionId: gameSessionId || undefined,
      customCharacters: selectedCustomChars,
      preferredRole: preferredRole || undefined,
    };
  };

  const getClientRegion = () => {
    if (typeof navigator === "undefined") return null;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    return `${navigator.language || "unknown"}|${timeZone}`;
  };

  const buildCreditConsumeOptions = () => ({
    createSession: true,
    playerCount,
    difficulty,
    usedCustomKey: false,
    modelUsed: MODEL_ID,
    userEmail: user?.email ?? null,
    region: getClientRegion(),
  });

  const waitForStartAnimation = async (startedAt: number) => {
    const remaining = Math.max(0, 800 - (Date.now() - startedAt));
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, remaining);
    });
  };

  const startGameWithCreditGuard = async (skipCredit: boolean) => {
    if (isStartingRef.current) {
      return;
    }

    isStartingRef.current = true;
    const animationStartedAt = Date.now();

    const seal = sealButtonRef.current;
    if (seal) createParticles(seal);

    setIsTransitioning(true);

    let creditAuthorized = skipCredit;
    let startRequestId: string | undefined;
    try {
      let gameSessionId: string | null = null;
      if (!skipCredit) {
        const result = await consumeCredit(buildCreditConsumeOptions());
        if (!result.success) {
          handleCreditFailure(result);
          return;
        }
        creditAuthorized = true;
        startRequestId = result.startRequestId;
        gameSessionId = result.sessionId ?? null;
      }

      await waitForStartAnimation(animationStartedAt);
      await onStart(buildStartOptions(gameSessionId));
      completeGameStartRequest(startRequestId);
    } catch (error) {
      console.error("[welcome] failed to start game", error);
      if (!creditAuthorized) {
        handleCreditFailure();
      } else {
        setIsTransitioning(false);
        onAbort?.();
      }
    } finally {
      isStartingRef.current = false;
    }
  };

  const handleConfirm = async () => {
    // ⚠️ 移植适配：上游这两个出口是**完全静默**的 return，用户只会看到「点了没反应」，
    // 无从判断卡在哪（实测排查这个 bug 花了好几轮）。这里给每一处都加上可见反馈。
    if (!canConfirm) {
      const busy = isLoading || isTransitioning;
      toast(busy ? (t('welcome.toast.loading') as string) : (t('welcome.signature.waiting') as string));
      return;
    }
    if (isStartingRef.current) {
      toast(t('welcome.toast.starting') as string);
      return;
    }
    const latestDemoConfig = await refreshDemoConfig(true);
    const demoModeActive = latestDemoConfig.active;

    // Demo mode: allow guests and skip credit checks
    // ⚠️ 移植适配：上游要求「先登录它自己的账号」，而小愈的身份由小愈负责
    // （请求头由 adapters/xiaoyu-identity.ts 注入，服务端据此识别用户与额度）。
    // 这里不再弹它那套登录框，它的 Supabase 登录在小愈里本来就用不了，
    // 会让用户卡在一个无法完成的登录上（表现为「点了没反应」）。
    // 真正的准入在服务端：/api/credits/consume 的每日次数闸门与点数账本。

    // ① 提前拦（2026-09-27 用户拍板 B）：额度**低于开局准入**时不必发那个注定 402 的请求
    //    直接走统一额度门控，用户立刻知道出路（游客→注册 / 已注册→获取额度或等明天）。
    //    `minStartTiao` 拿不到（老服务端 / 接口失败）时为 null → 落回下面那条「低余额提醒」旧行为。
    if (
      !demoModeActive &&
      !hasPendingGameStartRequest(buildCreditConsumeOptions()) &&
      credits !== null &&
      minStartTiao !== null &&
      credits < minStartTiao
    ) {
      // 游客判据：小愈 token 为空即游客（与 adapters/xiaoyu-identity 注入 Authorization 的规则同源）
      openQuotaGateway({ isGuest: !session?.accessToken, neededTiao: minStartTiao });
      return;
    }

    if (
      !demoModeActive &&
      !hasPendingGameStartRequest(buildCreditConsumeOptions()) &&
      credits !== null &&
      credits <= LOW_CREDIT_THRESHOLD
    ) {
      setIsLowCreditOpen(true);
      return;
    }

    await startGameWithCreditGuard(demoModeActive);
  };


  /**
   * 印章点击（移植适配，非上游原样）：
   * 上游把「还没签名字」表达为按钮 disabled：用户点了毫无反应、也没有任何提示，
   * 实测被当成「按钮坏了」。这里改为**保持可点**，并在名字为空时给出明确反馈：
   * 聚焦到输入框 + 复用上游自己的提示文案（welcome.signature.waiting）。
   */
  const handleSealClick = useCallback(() => {
    if (!humanName.trim()) {
      const el = document.querySelector<HTMLInputElement>('input.wc-signature-input');
      el?.focus();
      toast(t('welcome.signature.waiting'));
      return;
    }
    void handleConfirm();
  }, [humanName, handleConfirm, t]);

  const handleStartGameFromLowCreditModal = async () => {
    const latestDemoConfig = await refreshDemoConfig(true);
    await startGameWithCreditGuard(latestDemoConfig.active);
  };

  return (
    <>
      <div className="wc-contract-screen selection:bg-[var(--color-accent)] selection:text-white">
        <div className="wc-contract-fog" aria-hidden="true" />
        <div className="wc-contract-vignette" aria-hidden="true" />

        <GameSetupModal
          open={isSetupOpen}
          onOpenChange={setIsSetupOpen}
          playerCount={playerCount}
          onPlayerCountChange={setPlayerCount}
          preferredRole={preferredRole}
          onPreferredRoleChange={setPreferredRole}
          isGenshinMode={isGenshinMode}
          onGenshinModeChange={onGenshinModeChange}
          isSpectatorMode={isSpectatorMode}
          onSpectatorModeChange={onSpectatorModeChange}
          bgmVolume={bgmVolume}
          isSoundEnabled={isSoundEnabled}
          isAutoAdvanceDialogueEnabled={isAutoAdvanceDialogueEnabled}
          onBgmVolumeChange={onBgmVolumeChange}
          onSoundEnabledChange={onSoundEnabledChange}
                    onAutoAdvanceDialogueEnabledChange={onAutoAdvanceDialogueEnabledChange}
        />
        <AccountModal open={isAccountOpen} onOpenChange={setIsAccountOpen} />
        <UserProfileModal
          open={isUserProfileOpen}
          onOpenChange={setIsUserProfileOpen}
          email={user?.email}
          credits={credits ?? undefined}
          onChangePassword={() => setIsAccountOpen(true)}
          onSignOut={signOut}
        />
        <LowCreditModal
          open={isLowCreditOpen}
          onOpenChange={setIsLowCreditOpen}
          credits={credits ?? 0}
          onStartGame={handleStartGameFromLowCreditModal}
        />
        <CustomCharacterModal
          open={isCustomCharacterOpen}
          onOpenChange={setIsCustomCharacterOpen}
          characters={customCharacters.characters}
          loading={customCharacters.loading}
          canAddMore={customCharacters.canAddMore}
          remainingSlots={customCharacters.remainingSlots}
          selectedIds={selectedCharacterIds}
          onSelectionChange={setSelectedCharacterIds}
          onCreateCharacter={customCharacters.createCharacter}
          onUpdateCharacter={customCharacters.updateCharacter}
          onDeleteCharacter={customCharacters.deleteCharacter}
        />

        <Dialog open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
          <DialogContent className="max-w-[420px]">
            <DialogHeader>
              <DialogTitle>{t("welcome.mobileMenu.title")}</DialogTitle>
              <DialogDescription>{t("welcome.mobileMenu.description")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Button
                type="button"
                variant="outline"
                className="justify-start"
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  setIsSetupOpen(true);
                }}
              >
                <GearSix size={16} />
                {t("welcome.settings")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <div className="wc-welcome-actions absolute top-5 right-5 z-20 flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2">

            {user && (
              <button
                type="button"
                onClick={() => setIsUserProfileOpen(true)}
                className="hidden md:flex items-center gap-2 rounded-md border-2 border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                title={t("welcome.account.viewInfo")}
              >
                <UserCircle size={16} />
                <span className="truncate max-w-[160px]">{user.email ?? t("userProfile.loggedIn")}</span>
                <span className="opacity-70">
                  {unlimited
                    ? t("welcome.account.unlimited")
                    : t("welcome.account.remaining", { count: creditsLoading ? "..." : (credits ?? 0) })}
                </span>
                {/* A′（2026-09-17）：开局前必须告知本局约消耗多少，一局 40 条 ≈ 免费档两天额度，
                    不提示的话用户玩完才发现额度没了（这是当时最大的投诉来源）。 */}
                {gameEstimate != null && (
                  <span className="opacity-70">
                    {unlimited
                      ? t("welcome.account.gameCostUnlimited", { count: gameEstimate })
                      : t("welcome.account.gameCost", { count: gameEstimate })}
                  </span>
                )}
              </button>
            )}

            <Button
              type="button"
              variant="outline"
              onClick={() => setIsSetupOpen(true)}
              className="h-8 text-xs gap-2"
            >
              <GearSix size={16} />
              {t("welcome.settings")}
            </Button>
          </div>

          <div className="flex sm:hidden items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsMobileMenuOpen(true)}
              className="h-8 w-8 px-0"
              aria-label={t("welcome.mobileMenu.more")}
            >
              <DotsThreeOutlineVertical size={18} />
            </Button>
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.99, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.65, ease: "easeOut" }}
          className="relative z-10 w-full max-w-[460px] px-6"
        >
          <div ref={paperRef} className="wc-contract-paper">
            <div className="wc-contract-borders" aria-hidden="true" />

            <div className="mt-2 text-center">
              <div className="wc-contract-title">{t("app.shortTitle")}</div>
              <div className="wc-contract-subtitle">{t("welcome.subtitle")}</div>
            </div>

            <div className="mt-7 text-center wc-contract-body">
              <div className="wc-contract-oath">
                {t("welcome.oath.line1")}
                <br />
                {t("welcome.oath.line2")}
                <br />
                {t("welcome.oath.line3")}
              </div>

              <div className="mt-4">
                <div className="wc-contract-label">{t("welcome.signature.label")}</div>
                <div className="relative mt-2">
                  <input
                    type="text"
                    value={mounted ? humanName : ""}
                    onChange={(e) => setHumanName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      if (e.nativeEvent.isComposing) return;
                      if (isAnyModalOpen) return;
                      e.preventDefault();
                      void handleConfirm();
                    }}
                    placeholder={t("welcome.signature.placeholder")}
                    className="wc-signature-input"
                    autoComplete="off"
                    autoFocus
                    disabled={isLoading || isTransitioning}
                  />
                  <AnimatePresence>
                    {mounted && !!humanName.trim() && (
                      <motion.div
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                        className="wc-signature-ok"
                      >
                        <Sparkle weight="fill" size={18} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>


            {/* Custom Character Entry */}
            {user && (
              <button
                type="button"
                onClick={() => setIsCustomCharacterOpen(true)}
                className="mt-6 mx-auto flex items-center gap-2 px-3 py-1.5 rounded-md border-2 border-dashed border-[var(--border-color)] text-xs text-[var(--text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
              >
                <UsersFour size={14} />
                <span>{t("customCharacter.entryButton")}</span>
                {selectedCharacterIds.size > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-[var(--color-accent)] text-white text-[10px] font-medium">
                    {selectedCharacterIds.size}
                  </span>
                )}
                {customCharacters.characters.length > 0 && selectedCharacterIds.size === 0 && (
                  <span className="px-1.5 py-0.5 rounded-full bg-[var(--text-muted)]/20 text-[var(--text-muted)] text-[10px] font-medium">
                    {customCharacters.characters.length}
                  </span>
                )}
              </button>
            )}

            <div className="mt-4 flex flex-col items-center gap-3">
              {/* A′（2026-09-17）：**按印章前**就要看到本局花多少，藏在账号下拉里等于没提示 */}
              {gameEstimate != null && (
                <div className="wc-seal-hint" data-testid="ww-cost-notice">
                  {unlimited
                    ? t("welcome.sealHint.costUnlimited", { cost: gameEstimate })
                    : t("welcome.sealHint.cost", { cost: gameEstimate, remain: creditsLoading ? "..." : (credits ?? 0) })}
                </div>
              )}
              {/* A′ 回执：上一局结算完（局终 / 退出 / 10 分钟无调用）后，回来就能看到实际花了多少 */}
              {lastSettlement && (lastSettlement.used > 0 || lastSettlement.refunded > 0) && (!lastSettlement.at || Date.now() - lastSettlement.at < 12 * 3600 * 1000) && (
                <div className="wc-seal-hint" data-testid="ww-last-settlement">
                  {t("welcome.account.lastSettlement", { used: lastSettlement.used, refunded: lastSettlement.refunded })}
                </div>
              )}
              <div className="wc-seal-hint">
                {canConfirm ? t("welcome.sealHint.ready") : t("welcome.sealHint.waiting")}
              </div>
              <button
                ref={sealButtonRef}
                type="button"
                className="wc-wax-seal"
                onClick={handleSealClick}
                data-testid="ww-seal"
                /* 无障碍名（2026-09-21 真机走查）：印章是本模式的主按钮，但它是纯图标按钮
                   aria-label / title / 文本全空、SVG 也没 aria-hidden ⇒ 读屏用户听到一个没有名字的「按钮」。
                   这里补三语 label（welcome.sealAria）。 */
                aria-label={t('welcome.sealAria')}
                /* ⚠️ 移植适配：上游是 disabled={!canConfirm}（名字为空就禁用）。
                   实测用户点了没有任何反馈，只会以为「按钮坏了」。这里只在实际忙碌时禁用，
                   名字为空由 handleSealClick 给出明确提示。 */
                disabled={isLoading || isTransitioning || creditsLoading}
              >
                <FingerprintSimple weight="fill" size={44} className="wc-wax-seal-icon" />
              </button>
            </div>

            <div className="wc-corner-mark" aria-hidden="true">
              <WerewolfIcon size={30} className="text-[var(--color-wolf)] opacity-30" />
            </div>
          </div>
        </motion.div>

        <AnimatePresence>
          {isTransitioning && (
            <motion.div
              className="wc-transition-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            >
              <motion.div
                className="wc-transition-text"
                initial={{ opacity: 0, y: 10, scale: 1.05, filter: "blur(10px)" }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                transition={{ delay: 0.18, duration: 0.55, ease: "easeOut" }}
              >
                <div className="wc-transition-title">{t("welcome.transition.title")}</div>
                <div className="wc-transition-subtitle">{t("welcome.transition.subtitle")}</div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {showDevTools && (
        <>
          <DevModeButton
            onClick={() => {
              setIsDevModeEnabled(true);
              setIsDevConsoleOpen(true);
            }}
          />

          <AnimatePresence>
            {isDevConsoleOpen && (
              <motion.div
                initial={{ opacity: 0, x: 300 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 300 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="wc-dev-console fixed right-0 top-0 bottom-0 w-[400px] z-[120] bg-gray-900/95 backdrop-blur-md border-l border-gray-700 shadow-2xl flex flex-col"
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 bg-gray-800/50">
                  <div className="flex items-center gap-2">
                    <Wrench size={20} className="text-yellow-400" />
                    <span className="font-bold text-white">{t("welcome.dev.title")}</span>
                  </div>
                  <button
                    onClick={() => setIsDevConsoleOpen(false)}
                    className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
                    type="button"
                  >
                    <span className="text-xl leading-none">×</span>
                  </button>
                </div>

                <div className="flex border-b border-gray-700">
                  <button
                    type="button"
                    onClick={() => setDevTab("preset")}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${devTab === "preset"
                        ? "text-yellow-400 border-b-2 border-yellow-400 bg-gray-800/50"
                        : "text-gray-400 hover:text-white hover:bg-gray-800/30"
                      }`}
                  >
                    {t("welcome.dev.tabs.preset")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDevTab("roles")}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors ${devTab === "roles"
                        ? "text-yellow-400 border-b-2 border-yellow-400 bg-gray-800/50"
                        : "text-gray-400 hover:text-white hover:bg-gray-800/30"
                      }`}
                  >
                    {t("welcome.dev.tabs.roles")}
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {devTab === "preset" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-gray-300">{t("welcome.dev.preset.title")}</div>
                        <button
                          type="button"
                          onClick={() => setDevPreset("")}
                          className="text-xs text-gray-400 hover:text-white"
                        >
                          {t("welcome.dev.preset.clear")}
                        </button>
                      </div>
                      <select
                        value={devPreset}
                        onChange={(e) => setDevPreset(e.target.value as DevPreset | "")}
                        className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-yellow-400"
                      >
                        <option value="">{t("welcome.dev.preset.none")}</option>
                        <option value="MILK_POISON_TEST">{t("welcome.dev.preset.milkPoison")}</option>
                        <option value="LAST_WORDS_TEST">{t("welcome.dev.preset.lastWords")}</option>
                      </select>
                    </div>
                  )}

                  {devTab === "roles" && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-gray-300">
                          {t("welcome.dev.roles.title", { count: playerCount })}
                        </div>
                        <div className={`text-xs ${roleConfigValid ? "text-green-400" : "text-gray-400"}`}>
                          {roleConfigValid ? t("welcome.dev.roles.ready") : roleConfigHint}
                        </div>
                      </div>

                      <div className="flex items-center justify-between bg-gray-800/50 rounded-lg px-3 py-2 border border-gray-700">
                        <span className="text-xs text-gray-300">{t("welcome.dev.roles.overrideLabel")}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={devRoleOverrideEnabled}
                          onClick={() => setDevRoleOverrideEnabled(prev => !prev)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            devRoleOverrideEnabled ? "bg-yellow-500" : "bg-gray-600"
                          }`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                            devRoleOverrideEnabled ? "translate-x-[18px]" : "translate-x-[3px]"
                          }`} />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        {fixedRoles.map((role, idx) => (
                          <div key={idx} className="flex items-center gap-2">
                            <span className="w-10 text-xs text-gray-400">
                              {t("welcome.dev.roles.seat", { seat: idx + 1 })}
                            </span>
                            <select
                              value={role}
                              onChange={(e) => {
                                const next = [...fixedRoles];
                                next[idx] = e.target.value as Role;
                                setFixedRoles(next);
                              }}
                              className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white text-xs focus:outline-none focus:border-yellow-400"
                            >
                              {roleOptions.map((r) => (
                                <option key={r} value={r}>
                                  {roleLabels[r]}
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </>
  );
}
