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

---

# Follow-up 2026-11-10: the flak fuse, not the bots

**Step 1, hit instrumentation (4 matches, normal bots).** Per class: shots,
primary hits (direct or splash), primary damage.

| Ship | Kills/match | Shots | Primary hits | Hit % | Primary damage | Damage per hit |
|---|---|---|---|---|---|---|
| Dart | 3.5 | 940 | 147 | 15.6 | 1204 | 8.2 |
| Mule | 4.0 | 163 | 73 | 44.5 | 1031 | 14.1 |
| Scythe | 4.3 | 414 | 50 | 12.1 | 1383 | 27.7 |
| **Brute** | **0.5** | 267 | 55 | **20.6** | **116** | **2.1** |

Bot Brutes landed hits *more* often than Darts, but each hit did about 2
damage on a weapon spec'd at 18 direct plus 10 splash (design doc §5.3).

**Cause.** The proximity fuse fired the first tick a shell came within
4 m of a hit volume. Flak moves 2.8 m per tick, so a shell flying straight
at a ship always crossed that 4 m zone before it could reach the hull. It
detonated about 4 m short, and the linear splash (10 at 0 m, 0 at 5 m) gave
about 2. Accurate shots became near misses. That also explains the first
table above: speed, rate and hull changes couldn't help, and a bigger fuse
(7 m with an 8 m splash) did worse. It hit human Brute pilots exactly as
much as bots.

**Fix** (`packages/shared/src/combat/projectiles.ts`): the fuse holds while
the shell's flight line would strike the hull, and otherwise detonates at
the point of closest approach within 4 m. That's a near-miss fuse, as the
spec describes it. Regression tests are in `test/combat.test.ts`: a
dead-centre shell scores a direct hit, which fails on the old code with
"proximity".

**A/B, master vs fix (24 paired matches, seeds 1–24, all maps, normal bots).**

| Ship | Kills / match | Deaths / match | Avg place (of 8) | Match wins | Damage / match | Δ net kills (B−A) |
|---|---|---|---|---|---|---|
| Dart | 4.7 → 5.0 | 2.6 → 2.6 | 3.1 → 2.7 | 11 → 15 | 1800 → 1894 | +0.31 ± 0.50 |
| Mule | 3.6 → 3.6 | 3.9 → 3.9 | 4.1 → 4.3 | 5 → 4 | 1208 → 1217 | +0.04 ± 0.41 |
| Scythe | 4.2 → 3.2 | 3.4 → 3.1 | 3.4 → 4.3 | 8 → 5 | 1735 → 1447 | −0.71 ± 0.44 |
| **Brute** | **0.6 → 1.1** | 3.1 → 3.3 | **7.3 → 6.7** | 0 → 0 | **308 → 520** | +0.35 ± 0.24 (1.5σ) |

The fix is real: 69% more damage, almost double the kills, with the
mechanism pinned by a unit test. But it isn't enough on its own. Bot Brutes
still trail by about 3 kills a match, so the rest is bot habits (step 2).

**Step 2, closer engagement bands on top of the fix** (bot-only:
`preferredRange` is read by nothing but the bot brain; 24 pairs each,
`pnpm balance brute preferredRange.0=… preferredRange.1=… --matches 24`):

| Band (m) | Brute kills | Brute deaths | Damage / match | Direct-hit % | Avg place | Δ net kills |
|---|---|---|---|---|---|---|
| 80–300 (current) | 1.1 | 3.3 | 520 | 6% | 6.7 | — |
| 40–160 | 1.8 | 3.8 | 704 | 8% | 6.3 | +0.19 ± 0.34 |
| 30–120 | 2.4 | 4.6 | 837 | 12% | 6.0 | +0.00 ± 0.31 |

Closer play doubles the Brute's direct-hit rate and kills, but its deaths
rise in step, so net kills don't move. It trades more without trading
better. Nothing shipped from this.

## Next steps (kx9 stays open)

1. **Survival in close fights.** At 30–120 m Brutes die 4.6 times a match.
   Check whether bots use Bulwark when they're actually being shot at: the
   current habit is `recentDamage > 40` within 1 s, which may come too late
   for a 46 m/s ship. Also check whether they retreat or break off.
2. **Focus-fire.** Bots' target score favours low health and nearby
   targets, and a large, slow Brute may be everyone's first pick. Count how
   many attackers each class takes at once.
3. Read every rerun with the balance table's new damage and direct-hit
   columns, at 24 pairs or more.
