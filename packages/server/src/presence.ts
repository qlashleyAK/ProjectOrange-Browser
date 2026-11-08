/**
 * "N pilots online, M in matches" for the main menu.
 *
 * Pilots in matches are counted from the rooms (connected humans). Pilots on the menu have no socket, so
 * the menu pings `/api/presence?id=<ephemeral tab id>` every ~20 s and we count ids seen within the TTL.
 * The id is random per tab and never the identity token — presence can't be tied back to a pilot.
 */
export class Presence {
  private seen = new Map<string, number>();

  constructor(private readonly ttlMs = 45_000, private readonly cap = 50_000) {}

  /** Record a menu ping. Invalid ids are ignored; once at the cap, new ids are dropped (old ones still refresh). */
  touch(id: string | null, now: number): void {
    if (!id || !/^[a-z0-9]{6,24}$/.test(id)) return;
    if (!this.seen.has(id) && this.seen.size >= this.cap) {
      this.prune(now);
      if (this.seen.size >= this.cap) return;
    }
    this.seen.set(id, now);
  }

  /** Tabs that pinged from the menu within the TTL. */
  onMenu(now: number): number {
    this.prune(now);
    return this.seen.size;
  }

  counts(inMatch: number, now: number): { online: number; inMatch: number; onMenu: number } {
    const onMenu = this.onMenu(now);
    return { online: inMatch + onMenu, inMatch, onMenu };
  }

  private prune(now: number): void {
    for (const [id, t] of this.seen) if (now - t > this.ttlMs) this.seen.delete(id);
  }
}
