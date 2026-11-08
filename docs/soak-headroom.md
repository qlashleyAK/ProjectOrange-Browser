# Soak headroom — rooms per process (pre-launch baseline)

**Bead:** projectorange-browser-s25 · **Run:** 2026-10-18 by dzhopa-dream
**Method:** `pnpm --filter @orange/shared soak <min> normal <arena>` — 8 bots (full
room, worst case), 60 ticks/s, offline deterministic sim, measuring wall ms/tick.
**Hardware caveat:** measured on a shared-vCPU Hermes cloud container (baseline +
methodology only). **Re-run on the actual DigitalOcean droplet before launch** —
absolute numbers will shift; the ratios should hold.

## Results (ms/tick, 8 bots)

| Arena | avg | worst | Notes |
|---|---|---|---|
| Hollowdeep | 0.587–0.603 | 11.2–11.4 | two runs, consistent |
| The Gyre | 0.530–0.538 | 9.1–9.7 | cheapest sustained |
| Meridian Tower | 0.516 | 14.1 | worst spike of all (moving shafts?) |
| Gloamwood | 0.838 | 13.7 | heaviest avg, as expected — canopy colliders |

Worst ticks are warmup-weighted (first ticks after map build); steady-state is
the avg column.

## Extrapolation (8-player rooms, 60 Hz)

- **CPU per room:** avg 0.52–0.84 ms/tick → 31–50 ms of one core per second per
  room → **~20–30 full rooms per core** on sim cost alone (Gloamwood is the ~20
  end, Gyre/Tower the ~30 end).
- **On a 4-vCPU droplet:** theoretical ~80–120 concurrent full rooms (~640–960
  players). Derating for GameRoom + WS serialization overhead (unmeasured —
  sim is the dominant cost but not the only one), spike coincidence, and GC:
  **~40–60 full rooms per process is the safe launch cap**, ≈ 320–480 concurrent
  players per droplet.
- **Frame safety:** a single room's worst tick (14 ms) fits inside one 16.7 ms
  frame alone; with 50 rooms resident, coincident spikes would overrun, which
  is exactly why the cap sits at ~50% of theoretical.
- **Memory:** not cleanly measured from this container (process pollution);
  expected node + WASM baseline ~100–150 MB per process with rooms adding
  O(tens of KB). Measure on the droplet; revisit if that guess is wrong.
- 2- and 3-player rooms cost nearly the same (physics + entities dominate), so
  headroom should be planned in **rooms**, not players.

## What this means for the plan

- **L0 (one droplet) is far bigger than any realistic early load** — the L1
  scale-out step (assign endpoint + 2–4 servers) has no reason to exist until
  hundreds of concurrent players. The plan's "worst case is a queue" holds.
- **Gloamwood is the perf-tracking map**: if the balance/factory work ever
  regresses sim cost, it shows here first. These numbers are the baseline for
  a perf-regression check in CI or the review agent.
- **Ops rule of thumb for launch:** cap rooms per process at 50, expose the
  room count in telemetry, alert at 40.

## Follow-ups

- Re-run this file's table on the droplet, replace numbers, keep the file as
  the launch reference (bead: created).
- Real-server load test: N synthetic clients over WS against the deployed
  server to capture GameRoom/netcode overhead the offline sim doesn't include
  (bead: created).
