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

**Step 3, Bulwark and focus-fire** (8 matches, normal bots, fixed fuse):

| Ship | Deaths / match | Attackers in last 5 s before death | Share of time targeted | Bots on it when targeted |
|---|---|---|---|---|
| Dart | 2.7 | 2.14 | 47% | 1.51 |
| Mule | 4.0 | 2.14 | 54% | 1.67 |
| Scythe | 3.1 | 1.71 | 30% | 1.38 |
| Brute | 3.4 | 1.81 | 37% | 1.32 |

- **Focus-fire isn't the problem.** Brutes are targeted less than Darts or
  Mules, by fewer bots, and die to fewer attackers.
- **Bulwark is used.** It fires 7.6 times a match and absorbs 575 damage, 24%
  of incoming. When a Brute died, Bulwark was on cooldown in 41 of 54 deaths;
  only 5 had it ready but unused.
- **The gap is offence.** While engaged, bot Brutes held the trigger only
  31% of the time (Dart 48%, Scythe 49%) and were almost never short of
  energy (4%).

The bot only fires when its nose is within max(6°, the target's angular
size + 3 m) of its wandering aim point, and the Brute turns at 70°/s.
Flak doesn't need that precision: it detonates within 4 m and splashes
5 m. So the bot's fire cone now also includes the fuse and splash reach
for proximity-fused weapons. That's a bot-only change (`bots/brain.ts`),
and only flak has a fuse.

24 pairs, fuse fix alone vs plus the wider cone:

| Ship | Kills / match | Deaths / match | Avg place | Damage / match | Δ net kills |
|---|---|---|---|---|---|
| Dart | 5.0 → 5.0 | 2.6 → 2.1 | 2.7 → 2.5 | 1894 → 1830 | +0.48 ± 0.44 |
| Mule | 3.6 → 2.8 | 3.9 → 4.1 | 4.3 → 5.0 | 1217 → 1084 | −0.94 ± 0.46 ✱ |
| Scythe | 3.2 → 3.5 | 3.1 → 3.5 | 4.3 → 4.2 | 1447 → 1504 | −0.04 ± 0.41 |
| **Brute** | **1.1 → 1.5** | 3.3 → 3.2 | **6.7 → 6.3** | 520 → 580 | +0.50 ± 0.30 (1.7σ) |

This is consistent in direction but not yet 2σ. It's kept because it's
bot-only with a clear mechanism; drop the commit if the Mule cost matters.
Against `master` (fuse plus cone), Brute kills go 0.6 → 1.5 and average
place 7.3 → 6.3.

## Next steps (kx9 stays open)

1. **Damage per shot fired.** Bot Brutes now fire more but convert poorly:
   580 damage a match from flak rated 43 DPS. Check the aim lead for 170 m/s
   shells at 150 m (about 0.9 s of flight), and whether the torpedo gets used.
2. The Mule's −0.94 under the wider cone needs a look at more seeds.
3. Read every rerun with the balance table's damage and direct-hit
   columns, at 24 pairs or more.

## Stacked-fix baseline (2026-11-10, post PR #5 + #7, n=24, seeds 1-24)

| Ship | Kills | Deaths | Place | Wins | Damage | Direct-hit % |
|---|---|---|---|---|---|---|
| Dart | 5.0 | 2.6 | 2.7 | 15 | 1894 | 14% |
| Mule | 3.6 | 3.9 | 4.3 | 4 | 1217 | 56% |
| Scythe | 3.2 | 3.1 | 4.3 | 5 | 1447 | 12% |
| Brute | 1.1 | 3.3 | 6.7 | 0 | 520 | 6% |

Both fixes confirmed (reproduces PR #5's own measurement at n=24). The
residual: 6% direct-hit (vs Dart 14%) and 3.3 deaths/match — survival and
aim, not damage conversion, are what's left. Reproduce: `pnpm balance brute hull+=0 --matches 24 --seed 1`.
