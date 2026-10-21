/** Approved Prestige/Sovereign illustration family, independent of billing tier keys. */
export const PREMIUM_MEMBER_ART_SKINS = [
  'default', 'candy', 'healing', 'zen', 'star', 'aurora-glass',
  'midnight-library', 'neon-harbour', 'pixel-cottage', 'moon-courtyard', 'cream-editorial',
] as const;

export function premiumMemberArt(skin: string, plan: 'mini' | 'flagship', small = true): string | null {
  if (!(PREMIUM_MEMBER_ART_SKINS as readonly string[]).includes(skin)) return null;
  const name = plan === 'mini' ? 'prestige' : 'sovereign';
  return `/skins/membership-v2/${skin}/${name}${small ? '-sm' : ''}.webp?v=1`;
}
