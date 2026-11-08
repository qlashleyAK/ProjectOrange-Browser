/** JSON client for the game server's HTTP API: leaderboards, pilot profile, presence, daily challenge. */

export type LeaderboardWindow = 'day' | 'week' | 'alltime';

export interface LeaderboardRow {
  handle: string; kills: number; deaths: number; assists: number; wins: number;
  matches: number; damage: number; best_placement: number; last_seen: number;
}

export interface PilotProfile {
  handle: string; firstSeen: number; lastSeen: number;
  matches: number; wins: number; kills: number; deaths: number; assists: number; damage: number;
  shots: number; hits: number; oranges: number; peak_power: number; best_placement: number; seconds: number;
  classes: { classId: string; matches: number; kills: number }[];
}

/** One run on a day's challenge (best run per pilot). */
export interface DailyRow { handle: string; score: number; kills: number; deaths: number; oranges: number; placement: number; ended_at: number; arena: string }

export interface PresenceCounts { online: number; inMatch: number; onMenu: number; rooms: number }
export interface DailyInfo { date: string; mode: string; seed: number }

export interface RankedStatus {
  status: 'queued' | 'matched'; position?: number; elo?: number;
  room?: string; opponent?: string; opponentElo?: number;
}
export interface RankRow { handle: string; elo: number; rank: string; duels: number; wins: number }

async function request<T>(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: 'no-store', ...init, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // a server without persistence answers /api/* with the client's index.html
    if (!(r.headers.get('content-type') ?? '').includes('application/json')) throw new Error('no API on this server');
    return await r.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export function serverApi(origin: string) {
  return {
    leaderboard: (w: LeaderboardWindow, limit = 25) =>
      request<{ rows: LeaderboardRow[] }>(`${origin}/api/leaderboard?window=${w}&limit=${limit}`).then((r) => r.rows),
    /** text/plain POST: keeps the token out of URLs and needs no CORS preflight across regions */
    profile: (token: string) =>
      request<{ profile: PilotProfile | null }>(`${origin}/api/profile`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: token })
        .then((r) => r.profile),
    presence: (tabId: string) => request<PresenceCounts>(`${origin}/api/presence?id=${encodeURIComponent(tabId)}`),
    daily: () => request<DailyInfo>(`${origin}/api/daily`),
    dailyLeaderboard: (date: string, limit = 25) =>
      request<{ rows: DailyRow[] }>(`${origin}/api/daily/leaderboard?date=${encodeURIComponent(date)}&limit=${limit}`).then((r) => r.rows),
    /** text/plain POST body: no CORS preflight (same trick as profile), JSON inside */
    rankedJoin: (token: string, handle: string) =>
      request<RankedStatus>(`${origin}/api/ranked`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token, handle }) }),
    rankedLeave: (token: string) =>
      request<{ ok: boolean }>(`${origin}/api/ranked/leave`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token }) }),
    ranks: (limit = 25) =>
      request<{ rows: RankRow[] }>(`${origin}/api/ranks?limit=${limit}`).then((r) => r.rows),
  };
}

export type ServerApi = ReturnType<typeof serverApi>;

/** Random per-tab id for presence: never the identity token, so presence can't be tied to a pilot. */
export function presenceTabId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
