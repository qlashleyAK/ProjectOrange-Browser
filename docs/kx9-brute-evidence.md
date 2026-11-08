# kx9 evidence — Bot Brutes finish ~7th of 8 (balance A/B, 2026-11-08)

**Baseline (`pnpm balance brute hull+=0 --matches 8 --arena all`)** — bug confirmed emphatically:

| Ship | Kills/match | Deaths | Avg place (of 8) | Match wins |
|---|---|---|---|---|
| Dart | 4.5 | 2.6 | 3.3 | 3 |
| Scythe | 4.0 | 3.4 | 3.4 | 2 |
| Mule | 3.8 | 4.1 | 3.9 | 3 |
| **Brute** | **0.6** | **2.9** | **7.4** | **0** |

## Stat proposals tested (8 paired matches each, seeds 1-8, all arenas, normal bots)

| Proposal | Brute Δ net kills | Verdict |
|---|---|---|
| `primary.speed=240` (170→240) | −0.13 ± 0.43 | noise (0.3σ) |
| `primary.rate=3.2` (2.4→3.2) | +0.19 ± 0.63 | noise (0.3σ) |
| `hull=240` (200→240) | −0.31 ± 0.52 | noise (0.6σ) |
| `primary.proximity=7 splashRadius=8` | −0.75 ± 0.42 | noise (1.8σ) — trended WORSE |
| `preferredRange.0=40 preferredRange.1=150` (bots engage closer) | +0.13 ± 0.65 | noise (0.2σ) |

**Conclusion: no stat change moved bot-Brute performance at n=8.** The ship's
numbers are not the constraint in bot hands. The remaining suspects are in
`bots/brain.ts`:

- The fire gate is `dist < w.speed * w.life` (flak: 374 m) — bots happily fire
  slow flak across the room with aim error; only close fire connects.
- The aim model leads with projectile speed; whether it correctly models the
  flak's splash/proximity (vs point hits) is unverified.
- Bulwark (the defensive ability) usage by bots is unexamined.
- Positioning: a 46 m/s heavy in an open FFA may simply get focused first.

## Next steps (kx9 stays open)

1. Instrument per-ship hit rates in the harness (shots vs hits per class) to
   separate "can't land flak" from "lands it but can't convert kills."
2. If hit rate is the issue: brain-level fix (Brute-specific engage band and
   fire discipline), NOT a stat change — re-run this exact table after.
3. If hit rate is fine: investigate focus-fire/positioning and ability use.
4. Any rerun should be ≥24 paired matches — n=8 can't resolve <1 kill/match.
