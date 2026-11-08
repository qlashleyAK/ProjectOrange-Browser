# Project Orange — Public Release Plan (hosting, VIPER-parity features, scaling, open-source factory)

**Status:** DRAFT for owner review · written 2026-10-18 by dzhopa-dream at Quentin's direction
**Inputs verified:** repo state (3 maps, bots, quickplay matcher, private rooms, offline
bot mode, deterministic shared sim + soak harness), design doc §12/§22, viperoneone.com
feature survey, full git-history scan for secrets/private URLs (clean).

---

## Phase 0 — Pre-public hygiene (before the repo goes public)

- [x] **History scan: done, clean** (2026-10-18). Re-run before flipping: `git log --all -p | grep -Ei '(api[_-]?key|token|secret|password|https?://[^ ]*private)'`
- [ ] **License: MIT + third-party NOTICES** (owner leaning yes, 2026-10-18). VIPER 11
      is closed-source — no prior art to copy from them; the only licensing they expose
      is third-party attribution, which we also need (three.js MIT, Rapier-compat,
      Vite/Vitest MIT/Apache families). Decision: **MIT** with a NOTICES file.
- [ ] Close design-doc §20 [DECISION] items (owner) — they're defaults, not choices, and
      the public will read the doc as canon
- [ ] README rewrite for strangers: gif/video at top, play link, "how it's made" notes
      (VIPER's /notes page is the content-marketing move — copy THAT more than any feature)
- [ ] CONTRIBUTING.md + issue templates: 🐛 bug (browser, GPU, ping, repro steps),
      ⚖️ balance (ship, current vs expected, must cite numbers), 💡 feature
- [ ] SECURITY.md + a disclosure contact that isn't a personal email
- [ ] Community surface: **GitHub Discussions at launch** (owner has no Discord access);
      revisit Discord only if Discussions overflows

## Phase 1 — Hosting at projectorange.nexus (the boring, correct base)

**Provider decision (2026-10-18): DigitalOcean, NYC region.** Reasons: US-East
latency for players, managed-Postgres path matching our SQLite→PG migration,
per-second billing for scale-out — and, the deciding factor for this family:
**DO's docs ship an official MCP reference for AI agents**, so a Hermes agent
registers the DO MCP server and provisions/scales droplets, firewalls, DNS and
managed Postgres directly from chat or cron — no dashboard-clicking required.
(Hetzner's 2026 repricing + weak US footprint and Vultr's thinner agent story
lost; revisit only if costs diverge.) Cloudflare stays the edge layer (also
official-MCP-managed).

**Architecture: static assets ≠ game servers.**

```
projectorange.nexus
  ├── Cloudflare (free tier) ── DNS, TLS, cache static client bundle, DDoS shield
  │      └── client = Vite build → serve from CF (Pages/R2) or VPS + CF cache
  └── VPS (1× 4 vCPU / 8 GB, US-East, ~$20/mo)
         └── Node game server (rooms), Caddy TLS for wss://, SQLite → Postgres later
```

- Why this shape: the client bundle is immutable per build (perfect edge-cache — a viral
  spike costs ~nothing); the WS room server is the ONLY stateful, scaling-relevant part.
- The room server is **embarrassingly parallel**: rooms are independent (2–8 players,
  no cross-room state today), so horizontal scale needs no distributed-systems heroics.
- Staging: `staging.projectorange.nexus` on the same VPS (separate room map); deploy
  pipeline: tag → build → client to CF, server to VPS via SSH action; rollback = repoint.
- Add a `BUILD_VERSION` banner in-menu (already in shared/) — players can report it.

## Phase 2 — VIPER-parity features (what to copy, what to skip)

VIPER 11's real product isn't the jet — it's **the shell**: menu → identity → ladder →
presence. Translated to Orange, keeping the design doc's no-account-first ethos:

**Copy:**
1. **Front menu system** — main menu with: Quick Match (exists), Practice vs Bots
   (exists), **Ranked**, **Leaderboards**, **Profile**, Settings. VIPER-style: fast,
   keyboard-navigable, in-engine, no page loads.
2. **Persistent identity, lightweight** — anonymous browser token + optional handle
   (the doc already promises "no account"); stats keyed to the token; passkey sign-in
   later for the competitive crowd only. VIPER's "Level 1 Cadet" → rank titles earned
   by lifetime oranges (Juvenile → … → Foreman, mine-flavored).
3. **Ranked duels** — 1v1 queue with ELO/Glicko-lite, seasonal ladder, unranked FFA stays the default first
   experience. **Rank titles: Battlestar Galactica Colonial Fleet** (owner
   decision 2026-10-18): Nugget → Ensign → Lieutenant JG → Lieutenant →
   Captain → Major → Colonel → Commander → Admiral; the season's #1 also
   holds the **CAG** title. So say we all.
   Requires: match-report protocol (server → DB), queue in memory (Redis only when
   multi-server), 5-min timeout + bot forfeit.
4. **Leaderboards** — all-time / weekly / daily; per-ship and per-map cuts; the daily
   table doubles as the hook for #5.
5. **Daily challenge — rotating modes** (owner decision 2026-10-18): the daily
   seed picks from a mode rotation — Survival (outlast waves), Score Attack
   (orange-hoard vs bots on the seed), Mine Run (time-trial through
   Hollowdeep checkpoints). Deterministic sim makes every seed shareable,
   fair, and leaderboard-able. Best effort-to-payoff ratio in the shell.
6. **Presence counters** — "N pilots online, M in matches" on the menu. Trivial over
   WS, huge social proof, and it feeds our scale telemetry.
7. **"How it's made" notes** — dev-notes section on the domain. VIPER's notes page is
   doing real distribution work for them.

**Skip (deliberately):**
- **Shop/credits/payments** — a payments surface means chargebacks, VAT, minors, and
  moderation. Replace with **cosmetic unlocks via play milestones** (liveries for
  ships, trail colors). Same dopamine, zero liability. Revisit only if it's huge.
- **Campaign/missions** — daily challenge covers the retention hook at 10% of the
  scope. Post-launch if asked for loudly.

**New backend scope (small):** SQLite (better-sqlite3) → Postgres migration path;
`matches` + `players` + `daily_seeds` tables; server emits match reports; leaderboards
are SELECTs. No auth service, no email, no passwords — keep the surface boring.

## Phase 3 — Scaling for virality (the honest ladder)

- **L0 — one VPS (0 → ~500 concurrent):** as above. Watch: WS conns/process,
  room-tick CPU (use the existing soak script to find rooms/process headroom before
  launch — it's the tool that answers "when do we add a server" with numbers),
  DB write batch (match reports only, never per-tick).
- **L1 — split + scale out (500 → ~5k):** 2–4 game-server VPSes + a tiny
  **assign endpoint** (any server can answer "which server hosts room X / place me in
  a ranked match"): rooms stay independent; CF keeps assets; add per-IP rate limits and
  a hard room cap per server with a graceful "matchmaking queue" overflow instead of lag.
- **L2 — multi-region (only if it earns it):** region ping shown in menu, one game
  cluster per region, ladders global. Don't pre-build this; the assign endpoint in L1
  is the only piece that must not block it.
- **Abuse:** CF in front of everything; join links already exist for private rooms;
  add slow-mode on room creation per IP; bots-only abuse is capped by room size anyway.
- **The viral-day math that makes this safe:** 95% of a viral spike is asset traffic
  that Cloudflare serves free; the marginal cost is game-server CPU, which is capped
  by the room cap. Worst case is a queue, not a bill-shock.

## Phase 4 — Public repo + the software factory

**Repo mechanics:** PR CI = typecheck + vitest + build (all exist) + a client smoke
build; conventional commits; release tags + changelog.

**The factory — three agents, all things we're already good at:**

1. **Triager** — issue webhook → agent labels (bug/balance/feature), dupe-checks,
   asks for missing repro fields. For client bugs with repro steps: auto-repro via a
   **Playwright harness against the offline bot mode** (the game already runs fully
   offline — that's a gift; most web games can't do headless repro at all).
   Posts "reproduced on BUILD_VERSION / could not reproduce" with the transcript.
2. **PR reviewer** — CI gatekeeper + **design-doc invariant checks**: the doc's ship
   relationships ("who is faster, tougher, deadlier" §5, tuning tables) are stated as
   invariants — the agent diffs PRs against them and flags "this inverts the
   Falcon/Brute speed relationship" mechanically, plus perf-budget notes (§18).
3. **Balance evidence bot (the crown jewel)** — `/balance <ship> <proposed change>`
   comment on any issue/PR → agent runs **headless bot-vs-bot A/B sims** (old tuning
   vs proposed, N matches per ship matchup, using the deterministic sim + soak
   harness) → posts the win-rate delta table. Policy: balance PRs without sim
   evidence don't merge. Nobody in the .io-game space does this; it turns the loudest
   genre of complaint (nerf/buff wars) into a numbers conversation.

**Where it runs:** CI on GitHub Actions; the agents on family infrastructure —
alien-agenda's EPYC box (64 cores — the sim farm's natural home; balance runs are
batch and offline) with kestrel/baby handling triage ping duty. Work agents, not the
personal fam — same Slack-connected pattern as the project-orange-red-team amendment,
same approval rails. The factory's own work is queued in **beads** — initialized 2026-10-18: the
board lives in `refs/dolt/data` on this repo's origin (Dolt remote = git
origin, verified pushed), 13 backlog beads seeded from this plan, `bd
bootstrap` on any fresh clone, `bd ready --claim` is the agents' intake.

**Community surface:** a Discord (or GitHub Discussions first — fewer surfaces to
moderate at launch), the notes page, and one good launch post (r/WebGames,
r/threejs — "I made a 6DOF arena shooter in a browser tab, under 5MB" is a
legitimately strong title).

## Sequencing (owner's call on pacing)

1. Phase 0 hygiene + staging deploy on the VPS (private playtesting)
2. Identity token + match reports + SQLite + leaderboards + presence counter
3. Menus + ranked duels + daily challenge (the VIPER shell, complete)
4. Repo public + factory v1 (triager + reviewer), balance bot after 2 weeks of real PRs
5. Soft launch (the Reddit post) — staging stays for betas

**Open questions for the owner:** MIT vs other license · VPS provider/region ·
Discord-at-launch vs Discussions-first · rank-title naming · whether the daily
challenge should be survival or score-attack flavored.
