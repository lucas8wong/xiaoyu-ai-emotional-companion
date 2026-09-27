import { getSession } from "~/lib/session";
import { readGuestIdFromStorage, getGuestId } from "~/lib/demo-mode";
import { fetchDemoModeConfigClient } from "~/lib/demo-config";

export async function getAuthHeaders(): Promise<Record<string, string>> {
  // 小愈自己的登录态（不再有 Supabase 会话读取，也就不需要超时保护）
  const token = getSession()?.accessToken;
  if (token) return { Authorization: `Bearer ${token}` };

  const existingGuestId = readGuestIdFromStorage();
  if (existingGuestId) {
    return { "X-Guest-Id": existingGuestId };
  }

  const demoConfig = await fetchDemoModeConfigClient();
  if (demoConfig.active) {
    const guestId = getGuestId();
    if (guestId) return { "X-Guest-Id": guestId };
  }
  return {};
}
