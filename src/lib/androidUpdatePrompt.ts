/** In-memory only: one optional reminder per native foreground visit, including guests. */
export function createAndroidUpdatePromptGate() {
  let session = '';
  let shown = false;
  return {
    enter(next: string): boolean {
      if (next === session) return false;
      session = next; shown = false;
      return true;
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
