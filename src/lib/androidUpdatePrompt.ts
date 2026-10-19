/** In-memory only: one optional reminder per login, including a restored app session. */
export function createAndroidUpdatePromptGate() {
  let session = '';
  let shown = false;
  let checked = false;
  return {
    enter(next: string): boolean {
      if (next === session) return false;
      session = next; shown = false; checked = false;
      return true;
    },
    check(): boolean {
      if (!session || checked) return false;
      checked = true; return true;
    },
    pending(update?: string): boolean {
      return !!session && !shown && (update === 'available' || update === 'ready');
    },
    claim(update: string | undefined, blocked: boolean): boolean {
      if (blocked || !this.pending(update)) return false;
      shown = true; return true;
    },
  };
}
