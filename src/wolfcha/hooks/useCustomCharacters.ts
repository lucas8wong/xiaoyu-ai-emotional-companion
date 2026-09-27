"use client";

/**
 * 自定义角色（用于「用我自己的角色玩」）
 *
 * ⚠️ 移植适配（非上游原样）：上游把自定义角色存在 **Supabase** 的 `custom_characters` 表里，
 * 而小愈不使用 Supabase（密钥与登录用我们自己的，Supabase 已打桩）——
 * 结果是这个功能在小愈里**完全失效**（读写全落空，弹窗永远显示 0/20）。
 *
 * 现在改为：
 *  1) **小愈「聊一聊」里的角色**（`/api/analysis/chat/characters`）自动并入列表，
 *     这正好实现「把你在聊一聊里养的角色拉进狼人杀同桌」——身份/边界/语气都带过来；
 *  2) 用户在小愈狼人杀里临时新增的角色存**本地**（localStorage），可增删改。
 *
 * 对外接口与上游完全一致（characters/loading/error/fetch/create/update/delete/canAddMore/remainingSlots），
 * 所以所有调用方与 UI 都不用改。
 */
import { useCallback, useEffect, useState } from "react";
import type { CustomCharacter, CustomCharacterInput } from "~/types/custom-character";
import {
  DEFAULT_CUSTOM_CHARACTER_AGE,
  DEFAULT_CUSTOM_CHARACTER_GENDER,
  MAX_CUSTOM_CHARACTERS,
} from "~/types/custom-character";
import { getChatCharacters, type ChatCharacterMeta } from "../../services/api";

/** 本地临时角色的存储键（小愈侧的「聊一聊」角色不写这里，它们归小愈管理） */
const STORAGE_KEY = "xiaoyu.wolfcha.custom_characters";

/** 小愈角色的 id 前缀：带此前缀的条目为只读（在「聊一聊」里管理） */
const XIAOYU_PREFIX = "xiaoyu:";

function readLocal(): CustomCharacter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as CustomCharacter[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(list: CustomCharacter[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* 存储不可用时静默降级：本次会话内仍可用 */
  }
}

/** 小愈「聊一聊」角色 → 上游的自定义角色形状 */
function fromXiaoyu(c: ChatCharacterMeta): CustomCharacter {
  const name = (c.name || "").trim() || "未命名";
  const info = [c.identity, c.boundaries].filter((s) => typeof s === "string" && s.trim()).join(" / ");
  const at = new Date(c.createdAt || Date.now()).toISOString();
  return {
    id: `${XIAOYU_PREFIX}${c.id}`,
    user_id: "xiaoyu",
    display_name: name,
    gender: DEFAULT_CUSTOM_CHARACTER_GENDER,
    age: DEFAULT_CUSTOM_CHARACTER_AGE,
    mbti: "",
    basic_info: info.slice(0, 400) || undefined,
    style_label: c.voice || undefined,
    avatar_seed: c.avatar || name,
    is_deleted: false,
    created_at: at,
    updated_at: new Date(c.updatedAt || c.createdAt || Date.now()).toISOString(),
  };
}

const isXiaoyuEntry = (id: string): boolean => id.startsWith(XIAOYU_PREFIX);

/** 调用方传的是 Supabase 的 User；Supabase 在移植版里已打桩，这里只按结构取 id */
type UserLike = { id?: string } | null;

export function useCustomCharacters(user: UserLike) {
  const [characters, setCharacters] = useState<CustomCharacter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCharacters = useCallback(async () => {
    setLoading(true);
    try {
      const local = readLocal();
      let fromXy: CustomCharacter[] = [];
      try {
        const res = await getChatCharacters();
        if (res.success && Array.isArray(res.data)) {
          // 内置的「小愈」本人**也带进来**：产品原意是「没拉角色时就用默认 AI 伙伴」，
          // 小愈是用户最熟的那个伙伴，让她上桌正合此意；用户仍可自行勾选要不要用她。
          fromXy = res.data.map(fromXiaoyu);
        }
      } catch {
        /* 未登录/接口不可用：只显示本地角色，不阻断功能 */
      }
      setCharacters([...fromXy, ...local].slice(0, MAX_CUSTOM_CHARACTERS));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const createCharacter = useCallback(
    async (input: CustomCharacterInput): Promise<CustomCharacter | null> => {
      const list = readLocal();
      if (list.length >= MAX_CUSTOM_CHARACTERS) {
        setError(`Maximum ${MAX_CUSTOM_CHARACTERS} custom characters allowed`);
        return null;
      }
      const now = new Date().toISOString();
      const item: CustomCharacter = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        user_id: user?.id ?? "local",
        display_name: input.display_name.trim(),
        gender: input.gender ?? DEFAULT_CUSTOM_CHARACTER_GENDER,
        age: Number.isFinite(input.age) ? (input.age as number) : DEFAULT_CUSTOM_CHARACTER_AGE,
        mbti: input.mbti ?? "",
        basic_info: input.basic_info,
        style_label: input.style_label,
        avatar_seed: input.avatar_seed || `${input.display_name}-${Date.now()}`,
        is_deleted: false,
        created_at: now,
        updated_at: now,
      };
      const next = [...list, item];
      writeLocal(next);
      setCharacters((prev) => [...prev, item]);
      setError(null);
      return item;
    },
    [user],
  );

  const updateCharacter = useCallback(
    async (input: CustomCharacterInput & { id: string }): Promise<CustomCharacter | null> => {
      if (isXiaoyuEntry(input.id)) {
        // 来自「聊一聊」的角色在那边管理，这里只读
        setError("来自「聊一聊」的角色请在聊一聊里修改");
        return null;
      }
      const list = readLocal();
      const idx = list.findIndex((c) => c.id === input.id);
      if (idx < 0) return null;
      const merged: CustomCharacter = {
        ...list[idx],
        ...input,
        display_name: input.display_name?.trim() ?? list[idx].display_name,
        updated_at: new Date().toISOString(),
      };
      const next = list.slice();
      next[idx] = merged;
      writeLocal(next);
      setCharacters((prev) => prev.map((c) => (c.id === merged.id ? merged : c)));
      setError(null);
      return merged;
    },
    [],
  );

  const deleteCharacter = useCallback(async (id: string): Promise<boolean> => {
    if (isXiaoyuEntry(id)) {
      setError("来自「聊一聊」的角色请在聊一聊里删除");
      return false;
    }
    const next = readLocal().filter((c) => c.id !== id);
    writeLocal(next);
    setCharacters((prev) => prev.filter((c) => c.id !== id));
    return true;
  }, []);

  useEffect(() => {
    void fetchCharacters();
  }, [fetchCharacters]);

  return {
    characters,
    loading,
    error,
    fetchCharacters,
    createCharacter,
    updateCharacter,
    deleteCharacter,
    canAddMore: characters.length < MAX_CUSTOM_CHARACTERS,
    remainingSlots: MAX_CUSTOM_CHARACTERS - characters.length,
  };
}
