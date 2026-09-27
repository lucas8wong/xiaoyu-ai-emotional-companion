import { getLang } from '../i18n';

/**
 * 内置小愈的显示名 —— **唯一真源**。
 *
 * 为什么单独抽一个模块（2026-09-27 立）：
 * 内置角色的**记录名**恒为「小愈」（后端数据 / 角色列表接口），所以任何
 * 「把角色名直接渲染出来」的写法（`{c.name}`）在英文界面都会显示成中文。
 * 同类 bug 已经出现过至少两次（聊一聊顶栏、消息列表行），因此所有需要显示
 * 内置小愈名字的地方都必须走这里，而不是读 `character.name` 或写死字面量。
 *
 * 对外口径（见 AGENTS.md 红线②）：英文一律 **Xiaoyu**；简体与繁体都是「小愈」。
 */
export function companionShortName(lang?: string): string {
  return (lang || getLang()) === 'en' ? 'Xiaoyu' : '小愈';
}

export interface NamedCharacter {
  id?: string;
  isDefault?: boolean;
  name?: string;
}

/** 这个角色是不是内置小愈（含「还没加载出来」的空态） */
export function isBuiltinCompanion(c?: NamedCharacter | null): boolean {
  return !c || c.isDefault === true || c.id === 'xiaoyu';
}

/**
 * 渲染某个角色名时统一用它：内置小愈 → 跟随界面语言的短名；自定义角色 → 自己的名字。
 * 注意：自定义角色若是空的，也回落到内置短名，避免渲染出 undefined。
 */
export function displayNameForCharacter(c?: NamedCharacter | null, lang?: string): string {
  return isBuiltinCompanion(c) ? companionShortName(lang) : (c?.name || companionShortName(lang));
}
