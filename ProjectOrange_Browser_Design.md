# Project Orange — Browser Game Design & Build Handoff

> **Audience:** an implementing agent starting from an empty repository, with
> no other materials. Everything needed to build the game is in this document:
> design, tuning numbers, ship models (built procedurally in code), the arena
> layout, netcode architecture, and milestones.
>
> Items marked **[DECISION]** are defaults chosen so work can proceed; they are
> collected in Section 20 for the owner to confirm or change. Tuning numbers
> are starting points. Tune them in playtests, but keep the relationships
> between ships (who is faster, tougher, deadlier).

---

## 0. The game in one paragraph

A fast, zero-install, six-degrees-of-freedom arena shooter that runs in a
browser tab. Pilots fly one of four distinct ships through an enclosed,
abandoned asteroid mine, shooting each other with energy weapons and homing
missiles. Destroyed ships spill glowing **oranges**. Collecting oranges raises
your **power** for the rest of that life, upgrading your weapons and shields
and eventually unlocking an alternate fire mode and the **Repel** shockwave.
Dying drops half your power for someone else to grab. That makes every
powered-up pilot a juicy, dangerous target, so a match swings back and forth
instead of snowballing. Bots fill empty slots so there is always someone to
shoot.

### 0.1 Priorities, in order

1. **Time to fun.** Open a link and be flying and shooting in under 5 seconds on a cold
   cache, under 2 s warm. No account, no lobby required, optional name.
2. **Flying is fun on its own.** Responsive, expressive, easy to learn, deep to master.
3. **Shooting things feels great.** Punchy impacts, big explosions, readable
   hits, satisfying sound.
4. **The orange loop.** Kill, they drop oranges, you grab them, you get stronger,
   you become a bigger target.
5. **Ships with identity.** Four ships that play differently and counter each other.
6. **Multiplayer** with bots backfilling empty slots.

### 0.2 Definition of done (v1, "the shippable link")

- [ ] Desktop Chrome, Edge, Firefox, Safari. Keyboard+mouse with pointer lock
      and gamepad (Gamepad API).
- [ ] 60 FPS on a 2019-era integrated GPU at 1080p in the Default quality profile.
- [ ] Single-player vs bots works fully offline (no server).
- [ ] Online free-for-all room, 2–8 participants, bots fill empty slots, join by link.
- [ ] All four ship classes playable, selectable at spawn and respawn.
- [ ] Full loop works: spawn → fight → collect → power up → kill → drop →
      collect → respawn.
- [ ] Initial download ≤ 5 MB gzipped (ships and arena are generated in
      code, so most of the budget is JS + audio).
- [ ] Playable within 5 s on a 20 Mbps connection.

### 0.3 Originality rule

The four ships are **original designs** that evoke classic space-opera fighter
archetypes:

- a sleek three-engine human interceptor;
- a boxy human utility craft;
- a crescent-winged machine raider with a sweeping red scanner eye;
- a hulking machine heavy raider.

Do not copy any existing franchise's ship names, logos, insignia, or exact
silhouettes, and do not use franchise terms anywhere in code, assets, or UI.
Names in this document (Dart, Mule, Scythe, Brute, "Fleet", "Machine") are
placeholders the owner may rename.

---

## 1. Technology stack

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript** (strict), everywhere | One shared simulation codebase for client, server, bots, tests. |
| Rendering | **Three.js** (WebGL2; WebGPU renderer optional later) | Mature, small, huge ecosystem. |
| Physics | **Rapier 3D** (`@dimforge/rapier3d…`, WASM). Use the **deterministic build** on both client and server. Verify exact package names on npm (`@dimforge/rapier3d-deterministic` and its `-compat` variant). | Fast, runs in browser and Node, CCD, shape casts, world snapshot/restore. The deterministic build makes client prediction match the server bit-for-bit when inputs match. |
| Multiplayer framework | **Colyseus** (current release) for rooms, matchmaking, reconnection, and low-rate state sync. Custom binary messages for high-rate inputs/snapshots. | Solves the boring parts (rooms, join codes, reconnect, schema delta sync). Prediction/interpolation is ours either way; see Section 13. |
| Transport | WebSocket (via Colyseus) for v1. Abstract it so WebTransport datagrams can be added later where supported. | Universal support. Head-of-line blocking is acceptable at ≤ 8 players. |
| Build | **Vite** + pnpm workspaces | Fast dev loop, static deploy. |
| Post-processing | `postprocessing` (pmndrs): bloom, tonemapping, SMAA | Emissive weapons/oranges need bloom to read. |
| UI | DOM + CSS overlay for the HUD; Preact (optional) for menus | Crisp text, cheap. |
| Audio | WebAudio; mostly synthesized SFX + a couple of compressed loops | Tiny download. |
| Tests | Vitest (headless sim, physics, power math, netcode harness) | Fast, TS-native. |
| Hosting | Static client on Cloudflare Pages/Netlify; Colyseus server(s) on Fly.io or any VPS, 1–3 regions | Cheap; quickplay picks the lowest-ping region. |

Before committing to any dependency, check that it has had a release within
the last year. If Colyseus fights you, a ~400-line room server on `ws` or
`uWebSockets.js` is an acceptable replacement. The netcode layer in Section 13
is ours regardless.

---

## 2. Repository layout

```text
orange/
├── package.json                  pnpm workspace root
├── packages/
│   ├── shared/                   PURE TS + Rapier. No DOM, no three.js scene graph.
│   │   ├── constants.ts          tick rate, net constants, match rules
│   │   ├── classes/              dart.ts, mule.ts, scythe.ts, brute.ts — ShipClassDef data
│   │   ├── flight.ts             applyFlightControl(body, input, classDef, state, dt)
│   │   ├── physicsWorld.ts       Rapier world setup, collision groups, arena colliders
│   │   ├── arena/
│   │   │   ├── blueprint.ts      Section 15 data (rooms, tunnels, props, spawns, regions)
│   │   │   └── generate.ts       blueprint → slabs/colliders (+ render descriptors)
│   │   ├── combat/               weapons.ts, projectiles.ts, missiles.ts, damage.ts, hitVolumes.ts
│   │   ├── abilities/            overdrive.ts, sensorSweep.ts, cloak.ts, bulwark.ts, repel.ts
│   │   ├── power.ts              tiers, collection, drops, population
│   │   ├── match.ts              phases, scoring, respawn, spawn selection
│   │   ├── game.ts               GameSim: owns all entities, steps one tick
│   │   ├── bots/                 perception.ts, brain.ts, nav.ts
│   │   ├── rng.ts                seeded PRNG (mulberry32 / xoshiro)
│   │   └── net/                  codec.ts, messages.ts, quantize.ts
│   ├── client/
│   │   ├── main.ts
│   │   ├── input/                keyboard, pointer-lock mouse, gamepad → InputCmd
│   │   ├── ships/                procedural ship builders (Section 7), hull shader
│   │   ├── arena/                arena mesh builder from blueprint, materials, lights, signs
│   │   ├── render/               scene, camera rigs, projectiles, pickups, effects, post
│   │   ├── hud/                  DOM HUD (Section 16)
│   │   ├── audio/
│   │   ├── net/                  connection, clock sync, prediction, interpolation
│   │   └── modes/                offline (local GameSim) | online
│   └── server/
│       ├── index.ts              Colyseus server, /ping, /quickplay
│       └── OrangeRoom.ts         wraps GameSim; 60 Hz loop; snapshots; interest mgmt
└── tools/
    └── ship-viewer/              dev page: orbit each ship, silhouette test, export GLB
```

**Hard rule:** `packages/shared` runs identically in the browser and in Node.
Offline play runs `GameSim` inside the tab. Online, the server runs
`GameSim`, and the client runs the same flight code for its own ship's
prediction.

---

## 3. Units, axes, conventions

- Units: **meters, seconds, kilograms, radians internally** (degrees only in data tables).
- World axes are the Three.js defaults: right-handed, **+Y up**.
- Ship-local axes: **forward = −Z**, **right = +X**, **up = +Y**. Every ship
  model is built facing −Z.
- Input intents are normalized to [−1, 1]:
  - translation `t = { fwd, right, up }`;
  - rotation `r = { pitch, yaw, roll }`.
- Angular-velocity mapping (local frame):
  `ω = (+pitch·maxPitch, −yaw·maxYaw, −roll·maxRoll)` about (+X, +Y, +Z).
  **Verify with tests, not by reading math:**
  - `yaw +1` → nose swings **right**;
  - `pitch +1` → nose swings **up**;
  - `roll +1` → right wing goes **down** (clockwise from the cockpit).

---

## 4. Flight model (physics-based, arcade-tuned)

Ships are **Rapier dynamic rigid bodies**:

- gravity scale 0, body damping 0 (the controller does the damping);
- CCD enabled, mass set per class;
- collision handled entirely by Rapier.

Don't hand-roll movement integration or collision. A shared **flight
controller** turns input into physical changes each fixed tick.

### 4.1 Fixed timestep

- Simulation: **60 Hz** (`DT = 1/60`), `world.timestep = DT`.
- Client: accumulate frame time and run up to 6 ticks per frame. Carry the
  remainder, clamped to 0.25 s. Never drop remainder time; see Section 19.
- Render: interpolate between the last two physics states by `accumulator / DT`.

### 4.2 Flight Assist ON (default)

Assist ON gives Descent-style control: hold a direction and you go that way,
release and you coast to a stop.

```text
vLocal  = inverse(q) * body.linvel()
maxV    = class.maxSpeed (fwd / right / up per axis; reverse uses maxReverse)
boost   = input.boost && boostMeter > 0
if boost: maxV.fwd *= class.boostSpeedMult; accel *= class.boostAccelMult

vTarget = (t.right*maxV.right, t.up*maxV.up, -t.fwd*(t.fwd>=0 ? maxV.fwd : maxV.reverse))
if input.brake: vTarget = 0; accel *= 1.6

for each local axis i:
    dv[i] = clamp(vTarget[i] - vLocal[i], -accel[i]*DT, +accel[i]*DT)
body.applyImpulse( q * (dv * body.mass()), wake=true )
```

The controller supplies the "drag" by thrusting toward the target, so the
deceleration on release is limited by thrust. That feels physical but
controllable.

### 4.3 Flight Assist OFF (toggle, expert mode)

Pure Newtonian thrust. `impulse = q * (t * accel * mass * DT)` with no
auto-damping. A soft cap above `1.25 × maxSpeed` bleeds 2 m/s² so drifting
can't be abused into infinite speed. Brake still auto-stops. Assist mode is a
per-player toggle (`X` / gamepad D-pad up) and is part of the input command,
so the server simulates it too.

### 4.4 Rotation

```text
ωLocal   = inverse(q) * body.angvel()
ωTarget  = (pitch*maxPitch, -yaw*maxYaw, -roll*maxRoll)   // rad/s
ωNew[i]  = ωLocal[i] + clamp(ωTarget[i] - ωLocal[i], ±angAccel[i]*DT)
body.setAngvel( q * ωNew, true )
```

This is deliberate. Torque control on arbitrary inertia tensors feels mushy
and is hard to tune. Setting the angular velocity with an acceleration limit
is crisp. Collisions still spin the ship for a moment before the controller
recovers it, which reads well.

**Auto-level [DECISION: off by default, option in settings]:** when no roll
input is given for 1 s, gently roll toward the "floor" of the current room.

### 4.5 Boost meter

The boost meter runs 0 → 1. It drains at `class.boostDrain`/s while boosting
with any thrust input. It regenerates at `class.boostRegen`/s after 0.5 s
without boosting. At 0 the ship can't boost until the meter is back above 0.2.

### 4.6 Evasive roll (dodge)

The dodge is a signature skill move.

- **Trigger:** double-tap a strafe key (`A`/`D`) within 0.25 s, or press the
  dodge button (`V`, gamepad `A`) with a stick direction (default: right).
- **Effect:** an instant lateral velocity impulse of `class.dodgeDV` m/s in
  the chosen local direction. The roll target is overridden to one full 360°
  roll in that direction over 0.5 s, then normal control resumes.
- **Cost and cooldown:** costs 0.2 boost meter. Cooldown is `class.dodgeCooldown`.
- **No invulnerability frames.** It dodges by moving, not by ignoring hits.
- **Side effect:** breaks any in-progress enemy missile lock on you.
- The dodge request is an input bit; the server runs the same logic.

### 4.7 Collisions and contacts

- Ship colliders: restitution 0.3, friction 0.15. Arena: friction 0.3.
- **No collision damage by default [DECISION].**
- On contact-force events above a threshold, show sparks, play a scrape
  sound, and add a little camera shake.
- Ship-vs-ship collisions are real (dynamic vs dynamic) on the server.
  Mass matters: the Brute shoves a Scythe aside.

### 4.8 Aim contract

- Each ship has 1–4 **muzzles** (Section 7).
- Projectiles leave the muzzles along the ship's forward vector, converged
  to a point 250 m ahead.
- **Cameras never change aim.** First- and third-person views are
  presentation only.

---

## 5. Ship classes

Four classes are available from day one. "Fleet" and "Machine" are cosmetic
factions in free-for-all and become teams in a later team mode.

### 5.1 Overview

| | **Dart** | **Mule** | **Scythe** | **Brute** |
|---|---|---|---|---|
| Faction | Fleet (human) | Fleet (human) | Machine | Machine |
| Archetype | Interceptor / duelist | Utility / support-scout | Striker / ambusher (glass cannon) | Heavy / area denial |
| Promise | The honest dogfighter; best all-round handling | Owns close range and information; tough, strafes like a crab | Fastest and deadliest alpha, but paper-thin; strikes from cloak | Slow fortress; big splash, a shootable torpedo, blocks fire |
| Counter | Mule up close, Brute's flak | Scythe at range, Brute torpedoes | Mule's sweep, Dart's sustained fire | Dart/Scythe flanking, dodging the torpedo |

### 5.2 Flight and survivability

| Stat | Dart | Mule | Scythe | Brute |
|---|---:|---:|---:|---:|
| Size L × W × H (m) | 8.6 × 5.8 × 2.6 | 9.8 × 5.6 × 3.0 | 5.6 × 9.2 × 1.8 | 12.6 × 7.4 × 3.8 |
| Mass (t) | 10 | 18 | 7 | 32 |
| Hull | 100 | 130 | 70 | 200 |
| Shield | 90 | 110 | 60 | 140 |
| Shield regen delay / rate | 3.5 s / 15 /s | 3.0 s / 18 /s | 4.0 s / 12 /s | 5.0 s / 14 /s |
| Max speed fwd / reverse (m/s) | 70 / 40 | 58 / 45 | 80 / 35 | 46 / 25 |
| Max speed strafe / vertical | 45 / 45 | 52 / 52 | 40 / 40 | 30 / 30 |
| Accel fwd / lateral / vertical (m/s²) | 60 / 45 / 45 | 45 / 55 / 55 | 70 / 40 / 40 | 32 / 24 / 24 |
| Boost speed × / accel × | 1.6 / 1.5 | 1.5 / 1.4 | 1.7 / 1.6 | 1.5 / 1.6 |
| Boost drain / regen (meter/s) | 0.40 / 0.25 | 0.35 / 0.25 | 0.45 / 0.25 | 0.30 / 0.20 |
| Max rate pitch / yaw / roll (°/s) | 120 / 120 / 220 | 90 / 90 / 150 | 150 / 150 / 280 | 70 / 70 / 110 |
| Angular accel pitch / yaw / roll (°/s²) | 600 / 600 / 900 | 400 / 400 / 600 | 800 / 800 / 1200 | 250 / 250 / 400 |
| Energy max / regen (/s) | 100 / 24 | 120 / 20 | 100 / 26 | 140 / 18 |
| Dodge Δv / cooldown | 26 m/s / 1.2 s | 30 / 1.4 s | 30 / 1.0 s | 16 / 2.0 s |
| Repel shove taken | 100% | 100% | 100% | 50% (Heavy Frame) |

Shield damage is absorbed first and overflow goes to the hull. Shields
regenerate after the delay with no damage taken. **The hull never
regenerates.** Vitals fully reset on respawn.

### 5.3 Weapons

Common rules are in Section 8. Primaries cost energy per trigger pull, not
per projectile in a volley.

**Dart — Twin Pulse Cannons (primary).**
8 rounds/s total, alternating left/right muzzle; 8 damage; 300 m/s; 1.5 s
life (≈450 m); projectile radius 0.25 m; 4.5 energy per round. About 64 DPS,
sustainable for ~8 s from full.

**Dart — Seeker Missiles (secondary).**
4 at spawn. Hold the button to lock (0.6 s inside a 14° cone, ≤ 350 m, line
of sight required) and release to fire; no lock means it fires straight.
55 damage plus 4 m splash (50% at the edge); 140 m/s; turns 100°/s; 5 s life;
1.0 s refire.

**Dart — Overdrive (ability).**
Lasts 5 s: +35% primary fire rate, and boost doesn't drain. 20 s cooldown.

**Mule — Scatter Blaster (primary).**
7 pellets in a 3.5° cone; 1.8 shots/s; 6 damage per pellet (42 if all hit);
240 m/s; 0.8 s life (≈190 m); pellet radius 0.2 m; 18 energy per shot.

**Mule — Swarm Pod (secondary).**
3 salvos at spawn. Each salvo is 6 micro-rockets with a 0.4 s lock in a 20°
cone, ≤ 250 m. 12 damage each, no splash; 160 m/s; turn 160°/s; 3 s life;
1.5 s refire. Rockets spread out, then converge.

**Mule — Sensor Sweep (ability).**
A 300 m radius pulse. For 6 s it reveals every enemy inside the radius to the
Mule: outlined through walls and shown on the HUD. It **strips cloak** from
any Scythe it touches. It breaks every missile lock on the Mule, and missiles
already in flight toward it lose track. 18 s cooldown.

**Scythe — Ripper Spines (primary).**
3 shots/s; 22 damage; 380 m/s; 1.3 s life (≈500 m); radius 0.3 m; 12 energy
per shot.

**Scythe — Hunter Missile (secondary).**
2 at spawn. Lock 0.9 s inside a 12° cone, ≤ 450 m. 85 damage plus 5 m
splash; 120 m/s; turn 120°/s; 6 s life; 2.0 s refire.

**Scythe — Phase Cloak (ability).**
Lasts 5 s. The ship shows as a faint shimmer within 60 m and is **fully
hidden beyond 60 m**; enforced by the server (Section 13.8), not just by
rendering. Engines are silent and dark.

- **Breaks on:** firing, taking damage, being hit by Repel, or being touched
  by a Sensor Sweep.
- **Ambush:** the first primary shot fired out of cloak deals ×1.5 damage.
- Shields don't regenerate while cloaked.
- 22 s cooldown, starting when the cloak ends.

**Brute — Plasma Flak (primary).**
Fired from the dorsal turret along the ship's forward aim. 2.4 shots/s;
18 damage on a direct hit, plus 10 damage splash within 5 m with linear
falloff. Proximity fuse detonates within 4 m of an enemy hit volume.
170 m/s; 2.2 s life (≈375 m); radius 0.6 m; 12 energy per shot.

**Brute — Siege Torpedo (secondary).**
2 at spawn. Lock 1.2 s inside a 10° cone, ≤ 500 m. 130 damage plus 10 m
splash with falloff; 80 m/s; turn 45°/s; 9 s life; 3.0 s refire.
**The torpedo is shootable:** 40 HP and a 1.0 m hit sphere; any projectile
can destroy it.

**Brute — Bulwark (ability).**
Lasts 4 s: a curved energy barrier, a disc of 11 m diameter centered 8 m
ahead of the nose. It blocks enemy projectiles, missiles, and torpedoes
coming from the front and absorbs up to 300 damage before collapsing. The
Brute's own shots pass through. 20 s cooldown.

### 5.4 Time-to-kill sanity check

The table below assumes the attacker's primary only, every shot hitting, and
full shields and hull on the target.

| Attacker → target | Dart (190) | Mule (240) | Scythe (130) | Brute (340) |
|---|---:|---:|---:|---:|
| Dart, 64 DPS | 3.0 s | 3.8 s | 2.0 s | 5.3 s |
| Mule, ~75 DPS point-blank | 2.5 s | 3.2 s | 1.7 s | 4.5 s |
| Scythe, 66 DPS / 22 alpha | 2.9 s | 3.6 s | 2.0 s | 5.2 s |
| Brute, ~55 DPS + splash | 3.5 s | 4.4 s | 2.4 s | 6.2 s |

Target 2–6 s TTK under perfect aim; real fights run 2–3× longer. If a
playtest shows a dominant class, adjust that class's numbers. Don't flatten
the differences.

### 5.5 Class selection

- **First visit:** auto-spawn as Dart, with a "Change ship" hint in the HUD.
- **Death screen:** four class cards with stat bars, and the last pick is
  preselected. The respawn timer (3 s) runs while you choose. Opening the
  picker holds your spawn, up to 15 s.
- Class changes only happen at spawn.

---

## 6. Power: oranges and tiers

### 6.1 Terminology (enforce in code and UI)

- **Orange:** a glowing orange pickup worth power units.
- **Power units:** an integer, 0–10, that you keep only for the current life.
- **Tier:** a threshold that grants upgrades. Tiers are **absolute, not
  cumulative**: the active tier is the highest one at or below your current
  units.
- **The orange hue is reserved.** Warm orange (`#FF6A10`, hue ≈ 15°–45°) is
  used **only** for oranges and power feedback. No weapon, ship, room light,
  or UI accent may use that hue range.

### 6.2 Tier fields

Each tier can set any of these fields; unset fields use their defaults.

- `damage×` (default 1);
- `cadence×` (default 1) — multiplies fire rate;
- `shield×` (default 1) — multiplies the max shield;
- `+secondaryAmmo` (default 0) — a *top-up* only;
- `repel` (bool);
- `altPrimary` (bool) — swaps the primary for the class's alternate;
- `abilityCooldown×` (default 1).

Rules:

- **Shield ceiling.** Raising `shield×` raises the max but does not refill
  the shield. Losing a tier only clamps the current value down.
- **Ammo top-up.** Track the bonus ammo already granted this life. Crossing a
  tier adds only the difference, never a full refill.
- **Alternate primary [DECISION: swap].** At the tier that grants it, the
  primary is replaced by the class's alternate primary.
- **No carry-over.** Power never survives respawn. Respawn at 0 units.

### 6.3 Per-class power curves

Every class uses the same thresholds (2, 4, 6, 8, 10), so players learn one
rhythm. The upgrades differ per class.

**Dart**

| Units | Tier name | Upgrades |
|---:|---|---|
| 2 | Hot Barrels | damage ×1.1 |
| 4 | Tuned Coils | damage ×1.15, cadence ×1.15, shield ×1.1, +1 missile |
| 6 | Repel Online | damage ×1.2, cadence ×1.2, shield ×1.15, +1 missile, **Repel** |
| 8 | Quad Battery | **altPrimary: Quad Pulse**, shield ×1.2, +2 missiles, Repel |
| 10 | Ace | Quad Pulse, damage ×1.15, cadence ×1.15, shield ×1.3, +2 missiles, Repel, ability cooldown ×0.8 |

Quad Pulse fires 4 bolts per volley in a 2 × 2 cluster 1.2° apart: 6
volleys/s, 7 damage per bolt, 300 m/s, 6 energy per volley.

**Mule**

| Units | Tier name | Upgrades |
|---:|---|---|
| 2 | Hot Loads | damage ×1.1 |
| 4 | Wide Choke | 8 pellets, shield ×1.1, +1 salvo |
| 6 | Repel Online | damage ×1.15, shield ×1.2, +1 salvo, **Repel** |
| 8 | Arc Slug | **altPrimary: Arc Slug**, shield ×1.2, +1 salvo, Repel |
| 10 | Quartermaster | Arc Slug, damage ×1.2, cadence ×1.15, shield ×1.3, +2 salvos, Repel, ability cooldown ×0.75 |

Arc Slug is a single heavy slug: 40 damage plus 3 m splash, 2.2 shots/s,
320 m/s, 2.0 s life, 16 energy. It is the Mule's long-range answer.

**Scythe**

| Units | Tier name | Upgrades |
|---:|---|---|
| 2 | Honed | damage ×1.1 |
| 4 | Quickened | cadence ×1.15, shield ×1.1, +1 missile |
| 6 | Repel Online | damage ×1.2, cadence ×1.15, shield ×1.15, +1 missile, **Repel** |
| 8 | Twin Spines | **altPrimary: Twin Spines**, shield ×1.2, +1 missile, Repel |
| 10 | Reaper | Twin Spines, damage ×1.2, cadence ×1.2, shield ×1.25, +2 missiles, Repel, cloak cooldown ×0.75 |

Twin Spines fires 2 bolts in a 2° spread at 3 shots/s, 20 damage each,
14 energy per shot.

**Brute**

| Units | Tier name | Upgrades |
|---:|---|---|
| 2 | Heated Core | damage ×1.1 |
| 4 | Reinforced | cadence ×1.1, shield ×1.15, +1 torpedo |
| 6 | Repel Online | damage ×1.2, cadence ×1.1, shield ×1.2, +1 torpedo, **Repel** |
| 8 | Flak Storm | **altPrimary: Flak Storm**, shield ×1.25, +1 torpedo, Repel |
| 10 | Juggernaut | Flak Storm, damage ×1.2, cadence ×1.15, shield ×1.35, +1 torpedo, Repel, ability cooldown ×0.8 |

Flak Storm fires 3 flak balls in a 5° fan at 1.8 shots/s, 14 damage direct
plus 8 splash each, 18 energy per shot.

### 6.4 Repel (universal; granted at tier 6)

Repel is server-authoritative.

- **Shove:** a radius of **45 m** with falloff `Δv = 45 m/s × (1 − d/R)²`.
- **Targets:** every other living, non-spawn-protected ship, pushed away
  from the caster (direction = normalized offset). The shove is scaled by the
  target's "shove taken" stat.
- **Projectiles:** destroys enemy projectiles, missiles, and torpedoes
  inside the radius. They are destroyed, not reflected.
- **Limits:** at most 24 entities affected per activation; 12 s cooldown.
- **Also:** breaks a Scythe's cloak.
- **Visual:** the shockwave's visual radius **equals** the gameplay radius.

### 6.5 Collecting oranges

- A ship collects a pickup when
  `distance(shipCenter, pickup) ≤ 3.0 m + ship bounding radius`.
- **Magnet [DECISION: on]:** within 10 m, pickups drift toward the nearest
  eligible ship at up to 25 m/s. Server-simulated.
- **Order:** resolve once per server tick, pickups in spawn order. Each
  pickup goes to the **nearest** eligible ship, so simultaneous arrivals have
  a deterministic winner.
- **Grant:** `min(pickupUnits, 10 − held)`. A ship at full power does
  **not** consume pickups (no denial by sitting on them). Otherwise the whole
  pickup is consumed and any excess is lost.
- **Look:** pickups spin, bob gently, pulse, and scale with unit count; one
  shared instanced mesh.

### 6.6 World population

```text
target = 8 + ceil(activePlayers × 1.5), capped at 40 live world oranges
```

- **Spawning:** every 1 s, spawn up to 2 toward the target, so the
  population ramps instead of popping in. Population only runs during the
  InProgress phase.
- **Placement:** choose a weighted spawn region (Section 15.6), never the
  same region twice in a row. Try up to 12 random points and reject a point
  if it is:
  - within 1.5 m of geometry (Rapier intersection test with a ball);
  - within 60 m of any ship;
  - within 25 m of another pickup;
  - within 40 m of a spawn point;
  - within 50 m of a combat event (hit or death) in the last 8 s.
- **Determinism:** seed the PRNG per match.
- **Bonus regions:** world oranges in the "Sewer" tunnel spawn as 2-unit
  pickups (risk/reward route).

### 6.7 Death drops

- `dropUnits = ceil(units / 2)`, or 0 at 0 units.
- **Split:** into at most 4 pickups: `count = min(dropUnits, 4)`. Each gets
  `floor(total / count)`, and the first `total % count` get +1.
- **Scatter:** on a ring of radius 8 m around the death point, oriented
  perpendicular to the ship's last velocity. Shape-cast from the death point
  and stop 1.5 m short of walls.
- **Lifetime:** drops expire after **25 s**, blinking during the last 5 s.
  Global live-drop cap is 48 (trim the oldest).
- **Owner lockout:** none by default (keep the hook).
- **Killer markers:** drops from your kill are marked on your HUD, through
  walls, for 5 s.
- Drops don't count toward the world-population target.

---

## 7. Ship models (procedural, built in code)

There are no asset files. Each ship is generated at load time from the specs
below, using Three.js geometry and a few helper functions. This keeps the
download tiny and lets ships take per-player accent colors for free.

### 7.1 Builder helpers to implement (`client/ships/builders.ts`)

| Helper | What it does |
|---|---|
| `lathe(profile: [z, r][], segments, scaleY)` | LatheGeometry around local Z (rotate the default Y-axis lathe by 90° about X). A low segment count (8–12) gives a faceted, machined look. |
| `loft(sections: {z, halfW, halfH, yOff}[], ringPoints=16, exponent=2.5)` | Connects superellipse cross-sections into a closed hull, with caps. `exponent` 2 = ellipse, 2.5–4 = rounded box. |
| `extrudeOutline(points2D, thickness, bevel, plane)` | `THREE.Shape` from points (straight segments or quadratic curves) → ExtrudeGeometry, oriented into the XZ plane (wings) or the ZY plane (fins). |
| `taperAndDroop(geom, droopK, taperK, span)` | Post-process wing vertices: `y -= droopK·x²`, and scale thickness by `1 − taperK·|x|/span`. |
| `mirrorX(geom)` | Mirrored copy with corrected winding. |
| `roundedBox(w, h, d, r)` | `RoundedBoxGeometry` from three/addons. |
| `mergeByMaterial(parts)` | `mergeGeometries` per material → ≤ 6 meshes per ship. |

The builder returns a `THREE.Group` with named anchor nodes:

- `muzzle_0..n` (fire origins);
- `engine_0..n` (plume anchors, pointing +Z);
- `rcs_0..n` (optional small thrusters);
- `eye` (scanner, Machine ships only);
- `cockpit` (first-person camera).

### 7.2 Materials (shared, per faction)

All materials are `MeshStandardMaterial` with a procedural hull shader
(7.7) and an environment map from `PMREMGenerator` + `RoomEnvironment`, so
metal reflects.

| Name | Base color | Metal | Rough | Emissive |
|---|---|---:|---:|---|
| `fleetHull` | `#D9DCE0` off-white | 0.30 | 0.55 | — |
| `fleetDark` | `#3A3F46` | 0.60 | 0.45 | — |
| `canopy` | `#0B1A24` | 0.90 | 0.08 | `#0A2030` × 0.2 |
| `machineHull` | `#4A4F57` gunmetal chrome | 0.95 | 0.28 | — |
| `machineDark` | `#1C1F24` | 0.80 | 0.50 | — |
| `accent` | player color | 0.30 | 0.40 | player color × 0.6 (glow lines only) |
| `glowFleet` | — | — | — | `#9FE8FF` × 6 (engines) |
| `glowMachine` | — | — | — | `#C04BFF` × 6 (engines) |
| `scannerRed` | — | — | — | `#FF2030` × 8 (animated eye) |

**Player accent palette:** 10 saturated colors spaced around the hue wheel,
**skipping 10°–50°** (the reserved orange). Use the accent on hull stripes,
wingtips, glow lines, engine-trail tint, and nameplates.

### 7.3 Dart (Fleet interceptor)

Long, narrow, faceted fuselage; canopy forward; short swept wings with a
slight droop; one dorsal fin; **three engines in a triangle** at the tail;
twin guns flanking the nose. Overall 8.6 m long.

| Part | Build | Placement (local, m) | Material |
|---|---|---|---|
| Fuselage | `lathe` profile (z, r): (−4.3, 0), (−3.9, 0.22), (−3.2, 0.45), (−2.2, 0.62), (−1.0, 0.74), (0.5, 0.82), (2.0, 0.80), (3.0, 0.72), (3.4, 0.70); 10 segments; scaleY 0.8 | origin | fleetHull |
| Nose tip | cone r 0.22, h 0.7 | z −4.0, pointing −Z | fleetDark |
| Canopy | sphere scaled (0.42, 0.36, 1.5) | (0, 0.48, −1.5) | canopy |
| Wings ×2 | `extrudeOutline` (x, z): (0.6, −0.2) → (2.9, 1.9) → (2.9, 2.8) → (0.6, 3.0); thickness 0.16, bevel 0.04; anhedral −8° (tips down); mirror | y −0.15 | fleetHull |
| Wingtip caps ×2 | box 0.12 × 0.2 × 0.9 | (±2.95, −0.55, 2.35) | accent |
| Dorsal fin | `extrudeOutline` in ZY: (1.1, 0.6) → (2.7, 2.0) → (3.4, 2.0) → (3.4, 0.6); thickness 0.12 | x 0 | fleetHull, top band in accent |
| Engines ×3 | cylinder r 0.40, length 1.5, axis Z | (±0.52, −0.18, 3.75) and (0, 0.52, 3.75) | fleetDark |
| Nozzle rings ×3 | torus R 0.38, tube 0.06 | engine centers at z 4.5 | fleetDark |
| Engine glow ×3 | disc r 0.32 facing +Z | z 4.48 | glowFleet |
| Intakes ×2 | box 0.35 × 0.5 × 1.2 | (±0.8, 0, 0.6) | fleetDark |
| Guns ×2 | cylinder r 0.06, length 1.6, axis Z | (±0.42, −0.2, −3.0); muzzles at z −3.8 | fleetDark |
| Side stripes ×2 | box 0.02 × 0.18 × 4.0 | (±0.80, 0.1, 0.8) | accent |

- Anchors: muzzles (±0.42, −0.2, −3.8); engines at z 4.55; cockpit (0, 0.62, −1.4).
- Collider: capsule along Z (Rapier capsules run along Y, so rotate 90° about
  X), half-height 3.2, r 0.85; plus wing cuboid half-extents (2.9, 0.15, 0.85)
  at (0, −0.15, 2.0); plus fin cuboid (0.06, 0.7, 0.8) at (0, 1.3, 2.6).
- Hit spheres: (0, 0, −2.6) r 1.0; (0, 0, 0) r 1.1; (0, 0, 2.6) r 1.2;
  (±2.0, −0.2, 2.2) r 0.9.

### 7.4 Mule (Fleet utility craft)

Boxy, chunky, and practical. A chamfered rectangular body with a sloped
two-pane windscreen; **two engine nacelles** on short pylons; a sensor dome
underneath; a dorsal antenna; landing skids. Its RCS jets puff visibly when
it strafes.

| Part | Build | Placement | Material |
|---|---|---|---|
| Body | `loft`, exponent 4 (boxy), sections (z, halfW, halfH, yOff): (−4.8, 0.9, 0.45, −0.15), (−3.6, 1.25, 0.8, 0), (−1.0, 1.45, 1.1, 0.05), (2.0, 1.5, 1.15, 0.05), (3.2, 1.45, 1.1, 0.05) | origin | fleetHull |
| Windscreen | box 2.0 × 0.05 × 1.4, pitched −28° | (0, 0.62, −3.2) | canopy |
| Windscreen center bar | box 0.08 × 0.07 × 1.45, same pitch | (0, 0.64, −3.2) | fleetDark |
| Side windows ×2 | box 0.05 × 0.35 × 0.8 | (±1.47, 0.35, −2.2) | canopy |
| Nacelles ×2 | `roundedBox` 1.0 × 1.1 × 5.4, r 0.25 | (±2.3, −0.25, 0.9) | fleetHull |
| Nacelle stripes ×2 | box 0.02 × 0.2 × 3.5 | outer side of each nacelle | accent |
| Pylons ×2 | box 0.9 × 0.35 × 1.6 | (±1.75, −0.2, 0.9) | fleetDark |
| Nozzles ×4 | cylinder r 0.28, length 0.5, axis Z | (±2.3, 0.0, 3.7), (±2.3, −0.5, 3.7) | fleetDark |
| Engine glow ×4 | disc r 0.22 | nozzle ends, z 3.96 | glowFleet |
| RCS blocks ×8 | box 0.2³ | nacelle corners, front and rear | fleetDark + tiny glow |
| Rear hatch | box 2.2 × 1.6 × 0.05 | (0, 0.05, 3.22) | fleetDark |
| Sensor dome | hemisphere r 0.5, facing down | (0, −1.15, −1.2) | canopy, faint blue emissive |
| Antenna mast | cylinder r 0.05, h 0.9, plus dish (cylinder r 0.3, h 0.06, tilted 30°) | (0.6, 1.6, 1.0) | fleetDark |
| Chin guns ×2 | cylinder r 0.07, length 1.2 | (±0.35, −0.75, −4.3); muzzles at z −4.9 | fleetDark |
| Skids ×2 | box 0.08 × 0.08 × 3.0, 2 struts each | (±1.0, −1.35, 0) | fleetDark |

- Anchors: muzzles (±0.35, −0.75, −4.9); engines at the four nozzles;
  RCS × 8; cockpit (0, 0.55, −3.3).
- Collider: body cuboid half (1.5, 1.1, 4.0) at (0, 0, −0.8); nacelle
  cuboids half (0.5, 0.55, 2.7) at (±2.3, −0.25, 0.9).
- Hit spheres: (0, 0, −3) r 1.3; (0, 0, 0) r 1.6; (0, 0, 2.5) r 1.5;
  (±2.3, −0.25, 0.9) r 1.1; (±2.3, −0.25, 2.8) r 1.0.

### 7.5 Scythe (Machine raider)

A **crescent-winged** biomechanical raider. A smooth teardrop "head" sits at
the center, with a dark visor band across the front where a **red scanner
eye sweeps side to side**. Two curved wings sweep backward into sharp horns,
drooping toward the tips. Overall: chrome gunmetal, sinister, fast.

| Part | Build | Placement | Material |
|---|---|---|---|
| Head | sphere scaled (1.25, 0.85, 2.0) | (0, 0.1, −0.4) | machineHull |
| Dorsal ridge | `extrudeOutline` ZY: (−1.8, 0.75) → (0, 1.05) → (1.6, 0.8) → (1.6, 0.6) → (−1.8, 0.6); thickness 0.12 | x 0 | machineDark |
| Visor band | open cylinder segment r 1.0, h 0.18, theta 120°, scaled to hug the head front | (0, 0.15, −0.9) | machineDark (glossy black) |
| Scanner eye | sphere r 0.12; slides along the band ±50° (sine, 1.6 s period) | on the band | scannerRed |
| Wings ×2 | `extrudeOutline` (x, z) with curves: (0.9, −1.2) → (2.2, −0.9) → (3.4, −0.2) → (4.3, 0.9) → tip (4.6, 2.6) → (4.0, 1.9) → (3.0, 1.2) → (1.9, 0.9) → (0.9, 1.0); thickness 0.28, bevel 0.08; then `taperAndDroop(droopK 0.05, taperK 0.6, span 4.6)`; mirror | y 0 | machineHull |
| Wing ribs ×6 | thin extruded strips (0.06 wide, 0.05 tall) following the leading-edge curve, 3 per wing | wing top | machineDark |
| Leading-edge glow ×2 | TubeGeometry r 0.03 along the leading-edge curve | wing front edge | accent (emissive) |
| Vents ×2 | box 0.5 × 0.25 × 0.3, with glow plane at the rear | (±0.45, 0.05, 1.55) | machineDark + glowMachine |
| Spike guns ×2 | cone r 0.08, h 0.9, pointing −Z | (±1.2, −0.1, −1.3); muzzles at z −1.75 | machineDark |

- Anchors: muzzles (±1.2, −0.1, −1.75); engines at the vents; eye on the
  visor band; cockpit (0, 0.2, −2.3) — the "eye" view.
- Collider: ball r 1.25 at (0, 0.1, −0.4). Each wing has an inner cuboid
  half (0.9, 0.2, 0.9) at (±1.9, −0.1, 0), yawed ∓20°, and an outer cuboid
  half (0.6, 0.2, 1.1) at (±3.9, −0.6, 1.3), yawed ∓40°.
- Hit spheres: (0, 0.1, −0.6) r 1.3; (0, 0.1, 0.8) r 1.1; (±2.0, −0.1, 0) r 0.9;
  (±3.6, −0.5, 1.2) r 0.8; (±4.4, −0.9, 2.2) r 0.6.

### 7.6 Brute (Machine heavy raider)

A hulking armored wedge. Two **forward mandible prongs** frame a wide
scanner band; overlapping armor plates line the flanks; stubby downward
wings sit at the back; a dorsal plasma turret on top; **four big engine
vents** in a 2 × 2 grid.

| Part | Build | Placement | Material |
|---|---|---|---|
| Hull | `loft`, exponent 2.5, sections (z, halfW, halfH, yOff): (−4.6, 1.6, 0.9, −0.2), (−3.0, 2.4, 1.5, 0), (−0.5, 2.8, 1.8, 0.1), (2.5, 2.7, 1.7, 0.1), (4.8, 2.0, 1.3, 0), (5.6, 1.6, 1.0, 0) | origin | machineHull |
| Mandibles ×2 | `loft`, exponent 2, circular sections (z, r): (−3.6, 0.7), (−5.2, 0.55), (−6.4, 0.3), (−7.0, 0.05); centers curve from x ±1.5 to ±1.0 at the tip | y −0.5 | machineDark |
| Scanner band | box 2.4 × 0.3 × 0.1, glossy black | (0, 0.1, −4.55) | machineDark |
| Scanner eye | sphere r 0.16; sweeps ±1.0 m along the band | band | scannerRed |
| Armor plates ×4 | extruded quads 3.0 × 1.6, thickness 0.3, angled outward 15° and overlapping | (±2.85, 0.2, −1.0), (±2.75, 0, 2.0) | machineDark |
| Stub wings ×2 | `extrudeOutline` (x, z): (2.4, 0.5) → (3.7, 2.2) → (3.7, 3.6) → (2.4, 4.2); thickness 0.4; rolled −25° (down) | y −0.6 | machineHull, accent tip |
| Turret | hemisphere r 0.9, plus twin barrels (cylinder r 0.12, length 2.0, axis Z) | dome (0, 1.85, 0); barrels (±0.25, 2.0, −1.4); muzzles z −2.4 | machineDark |
| Engine vents ×4 | box 0.9 × 0.6 × 0.4, with glow plane | (±0.75, ±0.45, 5.6) | machineDark + glowMachine |
| Belly ribs ×5 | box 4.4 × 0.15 × 0.3 | y −1.75, z −2 … 3 | machineDark |

- Anchors: muzzles (±0.25, 2.0, −2.4); engines × 4; eye; cockpit (0, 0.5, −4.3).
- Collider: convex hull of all hull-loft ring points; plus a capsule per
  mandible, r 0.55, from z −3.6 to −6.6 at x ±1.3, y −0.5; plus stub-wing
  cuboids half (0.7, 0.2, 1.8) at (±3.1, −0.9, 2.4).
- Hit spheres: (0, 0, −3.2) r 1.8; (0, 0.1, 0) r 2.4; (0, 0, 3.4) r 2.1;
  (±1.3, −0.5, −5.6) r 0.7; (±3.2, −0.9, 2.4) r 0.9.

### 7.7 Hull detail shader

Add detail through `material.onBeforeCompile`, using object-space triplanar
projection so no UVs are needed.

- **Fleet:** a rectangular panel grid with cells 0.6–1.4 m, offset per cell
  by a hash. Panel lines are 1.5 cm wide at 45% darkening. Add subtle
  roughness noise, a few small dark "access hatch" rectangles, and faint
  grime toward the engines (by local z).
- **Machine:** flowing ridges, e.g. `sin(z·4 + noise(x, y)·2)` banding,
  plus pitting noise in roughness. Add a slow, subtle iridescent sheen via a
  fresnel tint (blue-violet, never orange).
- **Damage state:** below 50% hull, scorch decals (darkened noise blotches);
  below 25%, sparks and smoke trails from the hull (cosmetic).

### 7.8 Model quality gates

- Each ship is ≤ 6k triangles and ≤ 6 draw calls (after `mergeByMaterial`).
- **Silhouette test** (in `tools/ship-viewer`): render each ship as a flat
  black silhouette from the front, side, and top at 64 px. All four must be
  instantly distinguishable at a glance.
- Colliders are drawn as wireframe overlays in the viewer. They must hug the
  visible hull; a hit that "should have missed" is a fairness bug.
- Cloak shader (Scythe): fresnel rim, alpha 0.08–0.15, and a slight vertex
  shimmer. Engine glow off.

---

## 8. Common combat rules

- **Cadence** is tracked in ticks: a weapon can fire when
  `tick − lastFire ≥ round(interval / cadence× / DT)`.
- **Spread:** multi-projectile volleys fan symmetrically around the
  converged aim direction in the ship's local plane.
- **Projectile cap:** 160 live projectiles per ship. A volley that would
  exceed it is rejected whole.
- **Projectiles are not rigid bodies.** Each tick:
  - shape-cast or ray-cast from the old position to the new one against
    static arena colliders (Rapier query, static collision group);
  - test the segment against enemy **hit spheres** (lag-compensated; Section 13.7);
  - test against active Bulwark discs and shootable torpedoes.
- **Splash:** applies to ships within the radius at the current time, with
  linear falloff. It needs line of sight: a ray from the explosion to the
  ship center must not hit static geometry. **No self-damage [DECISION].**
- **Lock-on:** hold the secondary button. A lock reticle tightens over the
  target that is closest to the aim direction inside the cone, in range, and
  in line of sight. The lock is lost if the target leaves the cone, breaks
  line of sight, or dodges. Release to fire: with a lock the missile homes,
  without one it flies straight. Gamepad: hold LT.
- **Homing:** missiles turn toward the target at their turn rate, keeping
  speed. A missile loses track if the target leaves its 60° seeker cone or
  dies, then flies straight. Missiles collide with walls.
- **Warnings:**
  - a "LOCKING" tone and indicator when someone is locking onto you;
  - "MISSILE" with a direction arrow while missiles track you. Increment the
    counter on launch and decrement whenever that missile ends for any
    reason, so the warning can never stick on.
- **Ammo:** secondary ammo is restored only at respawn and through power-tier
  top-ups. **[DECISION]:** no ammo regeneration.
- **Death:**
  - idempotent: a dead ship takes no further damage, and a death is processed once;
  - destroys all of that ship's live projectiles and missiles;
  - triggers a big explosion and debris.
- **Spawn protection:** 2 s of immunity to damage and Repel. Firing,
  activating an ability, or collecting an orange ends it early.
- **Scoring:**
  - **Kill:** +1 to whoever dealt the killing damage (never for suicide or self-kill);
  - **Assist:** +1 to every other player who damaged the victim this life;
  - **Death:** +1 to the victim.
  - Show K / D / A.
- **Kill feed:** killer, weapon icon, victim, plus "+N oranges dropped".

---

## 9. Match flow

```text
WaitingForPlayers → Warmup (5 s; 3 s offline) → InProgress → PostMatch (12 s) → reset
```

- **Free-for-all:** first to **12 kills**, or most kills after **6 minutes**.
  Tiebreaker: fewest deaths, then most damage.
- **Start:** a match starts with ≥ 2 participants. Bots count, so in practice
  it starts immediately.
- **PostMatch:** scoreboard, top-3 podium, personal stats (damage, accuracy,
  oranges collected, peak power), then an automatic restart. Players are
  never kicked to a menu.
- **Late join:** spawn straight into an in-progress match.
- **Respawn:** 3 s after death, via the class picker (Section 5.5).
  - **Death cam:** the camera looks at your killer for 2 s, only if the
    killer is visible to you under the normal visibility rules.
- **Spawn selection:** score every spawn point by:
  - distance to the nearest living enemy (prefer > 120 m);
  - no line of sight to any enemy;
  - not in a room with a combat event in the last 5 s.

  Pick randomly among the top 3.

---

## 10. Controls

### 10.1 Bindings

| Action | Keyboard + mouse | Gamepad (standard mapping) |
|---|---|---|
| Thrust forward / back | W / S | Left stick Y |
| Strafe left / right | A / D (double-tap = dodge) | Left stick X |
| Up / down | Space / Z (Left Ctrl also bound) | RB / LB |
| Pitch / yaw | Mouse (pointer lock) | Right stick |
| Roll | Q / E | D-pad left / right |
| Boost | Left Shift | L3 |
| Brake | F | R3 |
| Dodge (explicit) | V + direction | A + stick direction |
| Primary fire | LMB | RT |
| Secondary (hold to lock, release to fire) | RMB | LT |
| Repel | R or MMB | Y |
| Class ability | G or Mouse 4 | B |
| Flight Assist toggle | X | D-pad up |
| Toggle camera (1st / 3rd person) | C | View / Back |
| Scoreboard | Tab (hold) | Menu / Start (hold) |
| Debug overlay | H | — |
| Menu / release mouse | Esc | — |

- **Browser hazards:** `Ctrl+W` closes the tab and cannot be blocked, and
  Alt opens menus on some platforms. That's why the defaults use Z and F.
- Call `preventDefault` on every handled key (Tab, Space).
- In Chromium fullscreen, use `navigator.keyboard.lock()` where available.
- Test every binding in Chrome, Firefox, and Safari.

### 10.2 Mouse

- **Default "direct" mode:** accumulate pointer-lock `movementX/Y` between
  ticks and spread it over the ticks run in that frame:
  `yawIntent = clamp(dx · sens · 0.2, −1, 1)` and the same for pitch
  (Y inverted so mouse-up = nose-up). Five pixels of motion in one tick is a
  full-rate turn. Tune the 0.2.
- **Optional "virtual joystick" mode:** the cursor offset from screen
  center, inside a visible ring, sets the turn rate. Good for trackpads.
- **Settings:**
  - yaw/pitch sensitivity 0.05–5 and invert pitch/yaw/roll;
  - FOV 60–120 (default 95), camera shake toggle;
  - flight-assist default, mouse mode;
  - controller deadzone (default 0.15) and response curve (default exponent 1.6).

### 10.3 Cameras

- **Third person (default):** chase distance 2.2 × ship length behind and
  0.35 × length above. Rotation follows with exponential smoothing,
  `1 − exp(−6·dt)`, and roll follows at 60% weight (comfort). A sphere-cast
  from the ship to the camera keeps it out of walls. Add slight FOV widening
  with speed (+8° at boost).
- **First person:** at the `cockpit` anchor; hide your own hull.
  - Fleet ships draw a simple cockpit-frame overlay.
  - Machine ships draw a red-tinted scanner overlay with a scan-line sweep.
- **Screen shake:** trauma-based. Own hits +0.25, nearby explosions by
  distance, Repel +0.4. Decays at 1.5/s. Toggleable.

---

## 11. Bots

Bots make the game alive with zero players online.

- **Same rules as players.** Bots produce `InputCmd`s through the same
  flight controller and weapon rules, and they run wherever the
  authoritative `GameSim` runs (the tab offline, the server online).
- **Perception follows the visibility rules.** Bots see an enemy only with
  line of sight within 600 m. They see a cloaked Scythe only within 35 m or
  right after it fires. A Mule bot's sensor sweep reveals for that bot only.
- **Brain** (utility scoring, re-evaluated every 250 ms):
  - **Hunt:** pick a target by distance, low health, and **high power**
    (bounty). Navigate toward it.
  - **Engage:** hold a class-preferred range (Dart 60–200 m, Mule 15–80 m,
    Scythe 150–400 m, Brute 80–300 m). Aim at the lead point
    `targetPos + targetVel · (distance / projectileSpeed)`. Fire when aim
    error is under a skill cone. Strafe perpendicular to the enemy's aim.
    Dodge when a projectile is about to hit.
  - **Collect:** chase oranges when no threat is near or an orange is much
    closer than any enemy. Always chase death drops after a kill.
  - **Evade:** on missile warning, boost, dodge, and break line of sight
    around geometry. A Mule uses Sweep to break locks; a Brute uses Bulwark.
  - **Retreat:** at low hull with no power, flee toward the room with the
    fewest enemies.
- **Class habits:**
  - **Dart:** Overdrive when engaging at < 150 m.
  - **Mule:** sweep every cooldown while hunting; close distance aggressively.
  - **Scythe:** cloak to approach, then ambush from behind.
  - **Brute:** torpedo at long range; Bulwark when it takes > 40 damage in 1 s.
- **Navigation:** a waypoint graph built automatically from the arena
  blueprint, with nodes at room centers, room quadrants, doorways, and
  tunnel elbows. A* over the graph. Local avoidance uses 5 Rapier ray-cast
  "feelers" ahead.
- **Skill levels (Easy / Normal / Hard):**
  - reaction delay 450 / 260 / 130 ms;
  - aim noise 4° / 2° / 0.8°;
  - fraction of max turn rate used 60% / 80% / 95%;
  - dodge chance 10% / 35% / 70%.
- **Names and roster:** pick from a list and tag them `[BOT]` on the
  scoreboard. Bots pick a class to keep the room's class mix varied.

---

## 12. Rooms and matchmaking

- **Room:** one Colyseus room, one `GameSim`. Up to **8 participants**
  (humans + bots).
- **Bot backfill:** keep at least **6** participants **[DECISION]**; the
  arena is large. When a human joins, remove one bot at its next death,
  never mid-fight.
- **Quickplay:** `GET /quickplay` returns the fullest room with a free slot
  in the best region; otherwise it creates one.
- **Region choice:** on load, the client pings each region's `/ping` 3 times
  and keeps the median.
- **Private rooms:** `/?room=CODE` joins or creates a private room. A "Copy
  invite link" button sits in the pause menu and on the post-match screen.
- **Reconnection:** hold a disconnected player's slot (ship despawned, score
  kept) for 20 s.
- **Version handshake:** the client sends its build hash. On a mismatch the
  server replies "new version available" and the client reloads.
- **Offline mode:** the same `GameSim` with bots runs in a Web Worker
  (keeps the main thread free); the renderer reads snapshots from it the
  same way it reads them from the network.

---

## 13. Netcode

### 13.1 Is there a library that does this for us?

Partly. Libraries cover **rooms and matchmaking** (Colyseus), **transports**
(WebSocket; WebTransport; WebRTC data channels via geckos.io), and
**interpolation helpers** (e.g. `@geckos.io/snapshot-interpolation`).
Rollback/lockstep libraries exist for peer-to-peer games, but they don't fit
an 8-player, late-joinable, physics-based shooter.

**No JS library does physics-aware client prediction for a 3D shooter.**
That layer is about 1.5–2k lines and is specified below. It is the standard
model used by competitive shooters:

- a server-authoritative fixed tick;
- client-side prediction of your own ship with replay;
- snapshot interpolation of everything else;
- lag compensation for your hits.

### 13.2 Authority

The server decides everything:

- movement results and collisions;
- projectiles, hits, and damage;
- deaths and score;
- pickups, power, ability cooldowns, and cloak/reveal.

Clients send **only input commands**. They never send positions, hits, or
pickups.

### 13.3 Clock sync and "input lead"

- **Clock sync:** the client estimates the server tick with ping/pong
  (NTP-style). Keep 8 samples and take the median offset. Resync every 2 s.
- **Input lead:** the client runs its own ship's simulation **ahead** of the
  server by enough ticks that each input arrives just before the server
  needs it. Target arrival margin: 1–2 ticks.
- **Buffer feedback:** the server reports each client's input-buffer depth in
  every snapshot:
  - underrun (input late): the client speeds its simulation up by 3%;
  - buffer deeper than 4: the client slows down by 3%.

  Time dilation runs **more or fewer fixed 1/60 steps per real second**; the
  step size never changes. It is imperceptible and converges in about a second.

### 13.4 Inputs

`InputCmd`, quantized, 12 bytes:

```text
u16 seq | u32 tick | i8 tFwd tRight tUp | i8 rPitch rYaw rRoll (×127)
| u16 flags: boost, brake, primary, secondary, repel, ability, dodgeL, dodgeR, dodgeU, dodgeD, assistOn
```

- **Quantize, then dequantize, then predict.** The client must simulate the
  same values the server will receive.
- **Sending:**
  - over WebSocket (reliable, ordered), send at 30 Hz, each packet carrying
    the inputs for the last 2 ticks;
  - over an unreliable transport, send at 60 Hz with the last 4 inputs for
    redundancy.

  Use **one** `MAX_INPUTS_PER_PACKET` constant for both the sender and the
  decoder, so a catch-up burst is never silently truncated.
- **Server input buffer** (per client):
  - consume exactly one input per tick;
  - if the buffer is empty, repeat the last input with fire, ability, and
    dodge bits cleared (counted as "missed"; the client gets corrected);
  - after 6 missed ticks, use a neutral input.
- **Validation:** cap at 75 inputs/s; sequence numbers must be monotonic,
  with wrap-safe comparison. A forward jump > 64 means a resync.

### 13.5 Own-ship prediction with Rapier

The client keeps a **prediction world**: a Rapier world containing the
static arena colliders, its **own ship as a dynamic body**, and all other
ships as **kinematic** bodies placed at their interpolated poses.

```text
every tick:
    cmd = sample input; quantize/dequantize
    history[cmd.tick] = cmd
    applyFlightControl(ownBody, cmd, classDef, ownState); world.step()
    predicted[cmd.tick] = pose+vel snapshot of ownBody (+ boost/dodge/assist state)

on server snapshot (own ship state S at server tick T, lastInputSeq):
    if distance(predicted[T], S) within tolerance (pos 5 cm, rot 0.5°, vel 0.2 m/s): ok
    else:
        set ownBody translation/rotation/linvel/angvel + controller state = S
        for t in T+1 .. currentTick: applyFlightControl(history[t]); world.step()
        visualOffset += (oldRenderPose - newRenderPose)   // smoothed away, below
```

- **Replay cost:** 15–20 replays of a world with one dynamic body is well
  under 1 ms in WASM.
- **Determinism:** use the deterministic Rapier build on both ends. Without
  ship-to-ship contact, prediction then matches the server exactly and
  corrections only happen around contacts and Repel.
- **Smoothing:** the render pose = physics pose + `visualOffset`. The offset
  decays exponentially with τ = 100 ms. Hard-snap (no smoothing) if the
  error is > 8 m or > 45°, or on respawn/teleport.
- **Never predict** other ships' reactions, Repel shoves, pickups, damage,
  or deaths. Those arrive from the server.

### 13.6 Remote entities: snapshot interpolation

- **Rate:** the server sends snapshots at **30 Hz**, each stamped with its tick.
- **Delay:** the client renders remote ships at
  `renderTick = estimatedServerTick − interpDelay`, where
  `interpDelay = 2 × snapshotInterval + 2 × jitter`, clamped to 66–200 ms.
- **Interpolation:** cubic Hermite for position (using velocity), slerp for rotation.
- **Starvation:** extrapolate at most 150 ms, then hold.
- **Discontinuities:** respawn, teleport, and spawn carry a `generation`
  counter that resets the interpolation buffer instead of interpolating
  across the gap.
- **Projectiles** are sent as events, not snapshots:
  - `spawn {id, ownerId, kind, origin, velocity, spawnTick}`;
  - `end {id, reason, pos}`.

  Clients advance straight projectiles deterministically. Missiles and
  torpedoes also stream position + velocity at 15 Hz. Remote projectiles
  render in the same delayed timeline as remote ships, so visuals stay
  consistent.

### 13.7 Lag compensation: shooter-timeline projectiles

Players aim at enemies they see, and they see them in the past (interp delay
plus one-way latency). To make hits feel fair:

- **Pose history:** the server keeps a 1 s ring buffer (60 ticks) of every
  ship's pose.
- **Shooter lag:** each authoritative projectile records
  `lagTicks = clamp(round((oneWayLatency + interpDelay) / DT), 0, 12)`
  (max 200 ms), taken from the shooter's measured values.
- **Ship tests use the past:** each tick, the projectile's segment is tested
  against enemy **hit spheres** posed at `currentTick − lagTicks`. World
  tests use the static arena, which doesn't move.
- **Exempt (present-time only):** homing missiles, torpedoes, flak
  proximity fuses, splash, and Repel. They are slow or area-based, and the
  victim's experience matters more there.
- **Cap:** the 200 ms cap limits "shot around a corner" moments for the victim.

### 13.8 Predicted firing (own shots)

- **Instant feedback:** when you pull the trigger, the client immediately
  spawns cosmetic projectiles from its predicted muzzles, plays the muzzle
  flash at 80% intensity, and plays the sound. Each shot gets
  `shotId = hash(playerId, tick, weaponSlot, index)`.
- **Server confirmation:** the server spawns the authoritative projectile
  with the same `shotId` when it processes that input. The client keeps its
  cosmetic projectile and gets impact and damage only from server events.
  If the server rejects the shot (cooldown, energy, dead), the cosmetic one
  fades out over 100 ms.
- **Hit confirmations** go to the shooter with damage and shield/hull split:
  hit marker, damage number (optional), and sound.

### 13.9 Snapshot contents and interest management

Per-ship snapshot entry, about 44 bytes:

```text
u8 entityId | u8 generation | i32×3 pos (mm) | smallest-three quat (u8 hdr + 3×i16)
| i16×3 linvel (cm/s) | i16×3 angvel (milli-rad/s) | u8 boost | u8 flags
(cloaked, shielded, bulwark, overdrive, spawnProtected, dead, assistOn)
```

- **Owner-only fields:** your own entry also carries `lastProcessedInputSeq`,
  energy, ammo, ability cooldowns, power, and dodge cooldown.
- **Everyone gets:** shields and hull at low precision (u8) for all ships,
  so health bars and bot-like AI on clients are possible.
- **Reliable state** (Colyseus schema, delta-synced automatically): match
  phase and timers, the roster with class/name/K/D/A/power, and the pickup
  list (spawn/consume/expire).
- **Events** (reliable messages): kills, tier changes, ability activations,
  Repel bursts, explosions.
- **Interest management (mandatory for cloak):** for each recipient,
  **omit** a cloaked enemy that is beyond 60 m and not revealed by that
  recipient's Sensor Sweep. Send a "vanished" event instead. Hiding it only
  in rendering would let a modified client see it.
- **Bandwidth target:** < 20 KB/s down and < 4 KB/s up per client at 8 participants.

### 13.10 Constants

| Constant | Value |
|---|---|
| Sim tick (server and client) | 60 Hz |
| Snapshot rate | 30 Hz |
| Interp delay | adaptive, 66–200 ms |
| Max extrapolation | 150 ms |
| Prediction history | 128 ticks |
| Correction smoothing τ | 100 ms; hard snap > 8 m or > 45° |
| Lag-compensation cap | 12 ticks (200 ms) |
| Server input buffer target | 1–2 ticks; adapt via time dilation ±3% |
| Missed-input repeat limit | 6 ticks, then neutral |
| Max inputs/s accepted | 75 |
| Reconnect grace | 20 s |

### 13.11 Server loop

- **Loop:** a drift-corrected 60 Hz loop (`performance.now()` accumulator;
  no bare `setInterval`). Each tick:
  1. pop inputs;
  2. apply flight control for every ship;
  3. `world.step()`;
  4. update projectiles, missiles, pickups, abilities, and the match;
  5. queue events.

  Every second tick, build a snapshot per client with interest filtering.
- **Budget:** < 3 ms per tick for 8 ships + 300 projectiles. If a process
  hosts several rooms, give each room its own worker thread.

---

## 14. Rendering and visual direction

### 14.1 Look

An abandoned asteroid mining complex, deep inside rock. The materials are
**dark rock and engineered metal** in a controlled value range, so weapon
light, landmark colors, and oranges pop. Each room has a **landmark color**
for orientation (Section 15). The warm orange hue belongs to oranges alone.

Weapon colors stay away from the reserved orange hue:

| Weapon | Color |
|---|---|
| Dart pulse | cyan-white `#9FE8FF` |
| Mule pellets | ice-white `#E6F4FF`, slug blue `#5AA0FF` |
| Scythe spines | crimson `#FF2A3A` |
| Brute flak | violet `#B35CFF` |
| Missiles | warm-white trail `#FFF1D6` + smoke |
| Torpedo | magenta core `#FF3FD0` |

### 14.2 Renderer

- **Renderer:** `WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })`,
  then post: bloom, ACES tonemapping, SMAA. sRGB output.
- **Environment:** `RoomEnvironment` through PMREM for metal reflections.
- **Static lighting:**
  - per room, 1–2 point/spot lights in the landmark color plus a dim
    hemisphere light;
  - only lights in the **current room and adjacent rooms** are enabled
    (room graph from the blueprint), so at most 6 static lights are live;
  - tunnels use emissive strips, not lights.
- **Dynamic lights:** a pool of ≤ 4 point lights, assigned each frame to the
  brightest/nearest effects. Everything else is emissive + bloom.
- **Visibility culling:** room-graph PVS — render the current room, its
  tunnels, and adjacent rooms. Static geometry is merged per room/tunnel and
  per material.
- **Instancing:** projectiles, pickups, debris, and sparks use `InstancedMesh`.
- **Quality profiles** (auto-chosen by a 2 s FPS probe on first load,
  changeable in settings):

  | Profile | Contents |
  |---|---|
  | Low | no bloom, 0.75 render scale, 2 dynamic lights, no debris |
  | Default | bloom, 1.0 scale, 4 dynamic lights |
  | High | + shadow from each room's main light, SSAO, more particles |

- **Tells vs cosmetics.** Gameplay never reads visual settings. Lower
  profiles may cut **cosmetic** effects only, never **tells**:
  - hits on you, deaths, missile and lock warnings;
  - Repel, Bulwark, cloak shimmer within 60 m;
  - pickup visibility.

### 14.3 Effects

Each effect is built from pooled primitives: additive billboards, expanding
spheres or rings, instanced sparks, and optional pooled lights. Charge `c`
ranges 0–1.

| Event | Visual | Size / duration | Channel |
|---|---|---|---|
| Muzzle flash | weapon-color flash sprite + light | r 0.6 → 1.2 m, 0.06 s | cosmetic (own: always) |
| Bolt / pellet | stretched additive quad (tracer) along velocity + soft glow | length ∝ speed × 0.03 s | tell |
| Projectile impact (world) | sparks (12) + flash + scorch decal (fades 8 s) | r 0.4 → 2.0 m, 0.15 s | cosmetic |
| Shield hit | translucent hex-pattern bubble flash at the ship's bounding radius, brightest at the impact point | 0.25 s, intensity 0.5 + c | tell |
| Hull hit | hot sparks + debris flecks + brief smoke puff | 0.3 s | tell |
| Missile trail | ribbon trail + smoke particles | 1.5 s fade | tell |
| Lock / missile warning | red pulsing HUD ring + edge arrow | while active | tell |
| Explosion (death) | expanding fireball sphere (white → violet/cyan per faction, never orange), shockwave ring, 20–40 debris chunks of the ship's material (ballistic, spinning, fade 3 s), big light | Scythe 8 m, Dart/Mule 12 m, Brute 18 m; 0.8 s | tell |
| Splash detonation | flash sphere + ring at the splash radius | r = splash radius, 0.35 s | tell |
| Repel | expanding refractive-looking ring + sphere front; visual radius = 45 m | 0.45 s | tell |
| Bulwark | curved hex-grid energy disc; ripples on absorb; cracks as it depletes | while active | tell |
| Cloak | shimmer within 60 m; on break, a crimson "decloak" flash | — | tell |
| Sensor Sweep | blue wavefront sphere expanding to 300 m (only the Mule sees the full sweep; others see a local ring when it passes) | 0.8 s | tell |
| Thrusters | additive cone plumes at engine anchors, length ∝ forward thrust, +60% when boosting; RCS puffs on strafe | continuous | cosmetic |
| Orange idle | emissive orange core + soft halo + gentle particles | — | tell |
| Orange collected | orange burst + "+N" floating text, rising chime | 0.35 s | tell |
| Tier gained | big orange ring around your ship + HUD flourish + fanfare | 0.6 s | tell |
| Low hull | sparks + smoke trail from the hull | while < 25% | tell |

Tell floors: minimum visible intensity, ≥ 0.12 s duration. **Reduce
flashing** (accessibility) scales intensity ×0.45 and duration ×1.3 but
never below the floors.

---

## 15. Arena: "Hollowdeep Mine"

An enclosed mining complex of **six rooms** joined by **ten tunnels and two
vertical shafts**. Every pair of rooms has **at least three distinct
routes**. The whole arena is described by a data **blueprint** and turned
into geometry and colliders by a generator, so it can be tweaked and later
extended.

### 15.1 Blueprint format

```ts
interface Room   { id: string; name: string; center: V3; size: V3; wall: 4; landmark: string; theme: Theme }
interface Tunnel { id: string; a: string; b: string; side: number; path: V3[]; theme: Theme; bonus?: boolean }
interface Prop   { room: string; kind: 'box'|'cylinder'|'rock'|'crystal'|'ring'; ...params; collides: boolean }
```

Rules:

- **Rooms:** an axis-aligned interior box (`center`, `size`), with walls
  `wall` meters thick outside the interior.
- **Tunnels:**
  - square cross-section `side × side`;
  - `path` is a polyline of **axis-aligned segments**, with points only at
    the two endpoints and at direction changes (elbows);
  - each endpoint lies on a room interior face, inside that face's bounds by
    at least `side/2`.

### 15.2 Generator algorithm (`shared/arena/generate.ts`)

1. **Doorways:** for each tunnel endpoint, find the room face it lies on and
   record an `side × side` doorway rectangle on that face.
2. **Room walls:** for each of the room's 6 faces, subtract the doorway
   rectangles:
   - collect every hole edge coordinate along the face's two axes;
   - form a grid of cells and keep the cells outside the holes;
   - greedily merge adjacent cells into maximal rectangles.

   Each rectangle becomes a wall **slab**: a cuboid `wall` thick behind the
   interior face.
3. **Tunnel segments:** each segment between path points becomes 4 slabs
   (the walls perpendicular to the segment axis), with interior
   `side × side`. Shorten the segment by `side/2` at each elbow.
4. **Elbows:** each elbow gets a cube junction of interior side `side`.
   Build 6 slabs minus the 2 openings where its segments attach.
5. **Room joins:** at endpoints, tunnel slabs start at the room's interior
   face plane, so they line the doorway through the wall thickness.
6. **Collision:** every slab becomes a Rapier `cuboid` collider in the
   static group. Props get cuboid, cylinder, or convex-hull colliders.
7. **Rendering:** slabs become boxes with world-space triplanar materials,
   merged per room/tunnel per material. Rock-themed surfaces are subdivided
   to about 3 m and **displaced only away from the interior** (into the
   wall, 0–3 m deep), so visuals never intrude into flyable space beyond
   the collider.
   - **Visual-only detail** (pipes, cables, greebles) may protrude at most
     1 m into the interior. Anything larger needs its own collider.
8. **Validation** (unit test, run at generation):
   - no two tunnel interiors overlap, and no tunnel interior overlaps a room
     interior except at its endpoints;
   - every doorway lies fully inside its face;
   - every room is reachable from every other room (graph);
   - an 18 m sphere-cast can traverse every tunnel end to end (the largest
     ship fits);
   - nothing collides inside a 20 m clearance zone in front of each doorway
     (props must respect this).

### 15.3 Rooms

The arena's overall extent is about 540 × 300 × 540 m.

| ID | Name | Center (x, y, z) | Interior size (x, y, z) | Landmark | Theme |
|---|---|---|---|---|---|
| hub | **The Crucible** | (0, 0, 0) | 140 × 90 × 140 | white `#E8F0FF` | refinery metal + rock |
| foundry | **Foundry** | (0, 0, −220) | 110 × 60 × 90 | magenta `#FF3FA0` | heavy industrial metal |
| dock | **Docking Bay** | (0, −10, 220) | 150 × 50 × 80 | blue `#3F8CFF` | clean hangar metal |
| reactor | **Reactor Shaft** | (220, 0, 0) | 70 × 220 × 70 | green `#4CFF7A` | tall cylindrical-feel metal |
| gallery | **Crystal Gallery** | (−220, 10, 0) | 120 × 70 × 120 | violet `#9A6BFF` | raw rock cave |
| crusher | **Ore Crusher** | (0, 150, 0) | 100 × 50 × 100 | teal `#2FE0D0` | worn machinery |

### 15.4 Tunnels and shafts

Path points are tunnel centerlines in world meters.

| ID | Connects | Side | Path |
|---|---|---:|---|
| T1 | hub ↔ foundry | 30 | (0, 0, −70) → (0, 0, −175) |
| T2 | hub ↔ dock | 30 | (0, −10, 70) → (0, −10, 180) |
| T3 | hub ↔ reactor | 30 | (70, 0, 0) → (185, 0, 0) |
| T4 | hub ↔ gallery | 30 | (−70, 10, 0) → (−160, 10, 0) |
| S1 | hub ↔ crusher | 26 | (35, 45, 0) → (35, 125, 0) |
| S2 | hub ↔ crusher | 26 | (−35, 45, 0) → (−35, 125, 0) |
| T5 | foundry ↔ reactor (upper ring) | 26 | (55, 15, −220) → (220, 15, −220) → (220, 15, −80) → (220, 60, −80) → (220, 60, −35) |
| T6 | reactor ↔ dock (lower ring) | 26 | (220, −60, 35) → (220, −60, 220) → (220, −15, 220) → (75, −15, 220) |
| T7 | dock ↔ gallery | 26 | (−75, −10, 220) → (−220, −10, 220) → (−220, −10, 60) |
| T8 | gallery ↔ foundry | 26 | (−220, 15, −60) → (−220, 15, −220) → (−55, 15, −220) |
| T9 | crusher ↔ reactor | 26 | (50, 150, 0) → (150, 150, 0) → (150, 90, 0) → (185, 90, 0) |
| T10 | crusher ↔ gallery | 26 | (−50, 150, 37) → (−120, 150, 37) → (−120, 32, 37) → (−160, 32, 37) |
| T11 | **"The Sewer"** hub ↔ dock (tight, twisty, `bonus: true`) | 18 | (−40, −45, −40) → (−40, −90, −40) → (−40, −90, 40) → (30, −90, 40) → (30, −90, 150) → (−40, −90, 150) → (−40, −90, 195) → (−40, −35, 195) |

These were laid out to avoid overlaps, but **the generator's validation
test is the authority.** If it reports an overlap, nudge the offending
segment by whole meters and keep the room-to-room routes.

Route check (≥ 3 routes per pair), for example:

- **foundry ↔ dock:** via hub (T1 + T2), via the east ring
  (T5 + reactor + T6), via the west ring (T8 + gallery + T7).
- **hub ↔ reactor:** T3; T1 + T5; S1/S2 + T9; T2 + T6.

### 15.5 Room contents

Positions are relative to the room center unless stated. Keep 20 m clear in
front of every doorway, and keep every passage at least 20 m wide.

**The Crucible (hub)**

- A central refinery column: cylinder r 9, floor to ceiling, with a glowing
  white band at y 0.
- Two catwalk rings around it at y −15 and y +20: octagons of radius 24
  built from box segments 18 × 1.5 × 4, with 2 of the 8 segments missing on
  each ring (fly-through gaps).
- 4 radial spokes per ring (box 15 × 1.5 × 3) connecting ring to column.
- 10 floating ore chunks (rock props, r 4–8, convex-hull colliders) at
  seeded positions outside the tunnel approach lanes.
- Shaft mouths S1/S2 in the ceiling have glowing teal rims.
- The Sewer opening in the floor has a hazard-stripe frame (yellow-green
  `#C8FF3A` and black; not orange).

**Foundry**

- 6 smelter blocks (14 × 24 × 14) standing on the floor at
  x ∈ {−30, 0, 30}, z ∈ {−20, +15}.
- Two crane girders spanning the room's width (110 × 3 × 3) at y +24,
  z −20 and +20.
- A hanging crucible under each girder (cylinder r 4, h 8, at y +16).
- Magenta glowing slag channels flush with the floor (emissive, no collider).
- Steam vents: particles, cosmetic.

**Docking Bay**

- 3 derelict cargo hulls (rounded boxes 14 × 12 × 40, long axis z) resting
  on the floor at x ∈ {−45, 0, 45}, z +15.
- An overhead gantry (150 × 2 × 4) at y +20, z −20.
- Landing-pad light grids on the floor.
- A huge sealed bay door on the far (+z) wall, with blue running lights and
  a starfield visible through narrow viewport slits. Visual only: the slits
  are glass with no gap.

**Reactor Shaft**

- A reactor core cylinder r 12, full height, with green emissive bands every
  30 m and a pulsing glow.
- 8 maintenance platforms (18 × 2 × 10) attached to the core at radius 20,
  from y −90 to +90 in ~25 m steps, rotating 45° per step.
- **Skip any platform** that would sit within 20 m of a doorway at a similar
  height (T3 at y 0 on the west face, T9 at y 90 on the west face, T5 at
  y 60 on the north face, T6 at y −60 on the south face).

**Crystal Gallery**

- A raw-rock cave: wall surfaces use displaced rock.
- 6 rock pillars (convex hulls, r 8–12) running floor to ceiling, outside
  the doorway lanes.
- A central **geode**: a rock core r 10 with 7 emissive violet crystals
  (elongated octahedra, 20–30 m long) radiating outward.
- Smaller crystal clusters on the walls (visual, ≤ 1 m protrusion).

**Ore Crusher**

- Two giant roller drums (cylinders r 10, length 60, along x) at y −15
  (just off the floor), z ±30.
- Conveyor belts (boxes 8 × 2 × 40) feeding them.
- Ore piles (low rock mounds on the floor, convex hulls).
- Teal warning lights.

### 15.6 Navigation aids, spawns, and orange regions

**Navigation aids**

- Every doorway gets an emissive frame in the **destination room's landmark
  color**, plus a sign above it with the destination name (canvas-texture
  text, emissive).
- Every tunnel has a lighter "floor" stripe and running lights on its floor
  edges, so players keep their orientation.
- At elbows, chevrons point toward each destination.

**Spawn points:** 3 per room (18 total).

- Place each one at the room center offset 35% of the room size toward a
  non-door face, at mid-height, facing the room center.
- Validate at generation that a 12 m sphere around each is free (Rapier
  intersection test). If not, nudge toward the center.

**Orange regions:**

- Each room's interior shrunk by 12 m on all sides. Weight =
  `sqrt(volume) / 100`, giving hub ≈ 9.4, gallery ≈ 6.5, reactor ≈ 6.4,
foundry ≈ 4.5, dock ≈ 4.3, crusher ≈ 3.9.
- Plus one region per tunnel segment longer than 60 m (the segment interior
  shrunk by 4 m), weight 1.0.
- Sewer segments carry `bonus: true`: their world oranges are worth 2 units.

### 15.7 Ambient audio zones

Each room has a looped ambience and a reverb preset (ConvolverNode with
small generated impulse responses):

- **Crucible:** big hall.
- **Foundry:** metallic clank + steam.
- **Dock:** wide hangar hum.
- **Reactor:** deep thrum.
- **Gallery:** cave drip + crystal chime.
- **Crusher:** grinding machinery.

Tunnels use a short tight reverb.

---

## 16. HUD (DOM overlay)

In priority order:

1. **Reticle.** A center cross with a gap; teal `rgba(90,255,220,.85)`,
   white in high-contrast mode. Spread brackets appear when the current
   weapon has spread. A **lead pip** sits on the nearest targeted enemy
   within 400 m **[DECISION: on by default, toggle in settings]**. The lock
   reticle tightens during lock-on.
2. **Vitals** (bottom left): a shield bar (blue `#33A6FF`) with a regen
   shimmer, and a hull bar (green `#8CD966` → red `#FF4026` below 25%).
   Shows "SPAWN PROTECTED" when active.
3. **Weapons** (bottom right):
   - energy bar (amber-yellow `#FFD84A` — keep it yellow, not orange);
   - secondary ammo pips;
   - class-ability icon with a cooldown ring;
   - Repel icon (locked/ready/cooldown);
   - dodge cooldown tick.
4. **Power:** 10 pips (filled = orange hue), the tier name, "next tier at N",
   and a flourish on tier-up.
5. **Threats:** "LOCKING" and "MISSILE" warnings with direction; edge arrows
   for off-screen enemies that are visible to you; a damage-direction arc
   when hit.
6. **Match** (top center): timer, your kills vs the leader's, phase banners
   ("WARMUP 3…", "MATCH POINT").
7. **Location** (top left): the current room name (navigation in a big arena).
8. **Kill feed** (top right), **hit marker** + optional damage numbers, and
   toasts ("+2 ORANGES", "TIER 6 — REPEL ONLINE").
9. **Network warning:** only when RTT > 150 ms or loss is detected.
10. **Scoreboard** (hold Tab): name, class icon, K/D/A, power, ping, `[BOT]`
    tag.
11. **Debug overlay** (H): FPS, frame ms, tick, RTT, interp delay,
    corrections/s, input buffer depth, speed, assist state. Never mixed into
    the combat HUD.

**Accessibility:** reduce flashing, high-contrast reticle, colorblind-safe
enemy markers (shape + color), FOV slider, screen-shake toggle, HUD scale
75–150%, subtitles for voice/announcer lines.

---

## 17. Audio

- **Graph:** a WebAudio graph master → (SFX, UI, music, ambience) buses,
  with a compressor on master.
- **Positional sound:** `PannerNode` (HRTF) for world sounds, with distance
  rolloff tuned for a 0–400 m combat range.
- **Unlock:** unlock the AudioContext on the first user gesture.
- **Synthesis:** synthesize most SFX at load (oscillators, noise, filters,
  envelopes; a jsfxr-style generator), cached to AudioBuffers. Only the music
  loop and maybe 2–3 signature sounds are files (compressed, ≤ 1 MB total).

Sound list:

- **Weapons:** per-class primary fire (Dart crisp zap, Mule chunky shotgun
  blast, Scythe high metallic shriek, Brute deep plasma thump). Your own
  shots are louder and closer.
- **Missiles:** launch whoosh; in-flight loop; lock-on tone (rising beeps)
  and solid-lock tone; **incoming-missile alarm** (non-positional, urgent);
  torpedo low drone.
- **Impacts:** shield hit (bright crackle), hull hit (metal crunch), world
  impact (ping), explosion (big, layered, with sub-bass), splash pop.
- **Oranges:** pickup chime with pitch rising with power level; tier-up fanfare
  (short, bright); drop scatter (glassy tinkle).
- **Abilities:** Repel (whoomp + whoosh), Overdrive (spin-up hum), Sensor
  Sweep (sonar ping), Cloak on/off (phase shimmer), Bulwark up/absorb/break.
- **Ships:** engine hum per faction (Fleet: turbine whine; Machine: pulsing
  organic drone), pitched by speed, with a boost roar; RCS puffs; wall scrape;
  the Machine scanner "whir-whir" sweep (quiet, 3D, iconic).
- **UI:** clicks and countdown beeps; announcer stings ("Double kill", "Match
  point") as synthesized vocoder-ish blips **[DECISION: optional]**.
- **Music:** one driving synth loop during matches, ducked under combat SFX.
  Calm menu loop.

---

## 18. Performance budgets

| Item | Budget |
|---|---|
| Frame (Default profile, 1080p, iGPU) | 16.6 ms |
| Draw calls | < 200 (room PVS culling) |
| Triangles on screen | < 400k |
| Client sim tick incl. prediction replay | < 1.5 ms |
| Server tick (8 ships, 300 projectiles) | < 3 ms |
| Ship generation at load (4 classes) | < 150 ms total |
| Arena generation at load | < 500 ms (in a worker if needed) |
| Initial JS (gzip, including Rapier WASM) | < 1.5 MB |
| Total initial download | < 5 MB |
| Bandwidth down / up per client | < 20 KB/s / < 4 KB/s |

- **No allocation in hot loops.** Pool vectors, projectiles, effects, and
  particles.
- **Rapier WASM:** load it in parallel with the menu, so the first match
  doesn't wait on it.

---

## 19. Pitfalls to avoid

1. **Quantize before predicting.** Otherwise every tick diverges from the server.
2. **One batch-size constant** for the sender and the decoder.
3. **Never drop accumulator time** on frame hitches (clamp at 0.25 s and
   carry it). A hitching client otherwise sends too few inputs, and the
   server's buffer underruns.
4. **Same Rapier build and version** on client and server, and the same
   order of operations (create colliders in blueprint order, apply forces in
   entity-id order).
5. **Background tabs:** `requestAnimationFrame` stops.
   - **Offline:** pause the match.
   - **Online:** keep the socket alive. On return, hard-resync your own ship
     from the latest snapshot instead of replaying minutes of input.
6. **Browser shortcuts:** Ctrl+W, Alt, Tab, F-keys, and Esc releasing
   pointer lock are browser-enforced. Design around them.
7. **Interest management, not rendering, hides cloaked ships.**
8. **Tells survive every quality level.**
9. **The reserved orange hue.** Audit every color: room lights, UI accents,
   hazard stripes, explosions (keep fireballs white/cyan/violet).
10. **No gameplay code reads render state or settings.** `shared/` imports
    nothing from three.js scenes, the DOM, or user settings.
11. **Clean-checkout CI.** Run tests and a production build from a fresh
    clone on every push; local incremental builds hide problems.
12. **Colliders must match the visuals.** Check this in the ship viewer every
    time a model changes.

---

## 20. Decisions (defaults chosen; owner may override)

| # | Topic | Default |
|---|---|---|
| 1 | Shield regeneration | On, per-class delay/rate (Section 5.2). The hull never regenerates. |
| 2 | Alternate primary at tier 8 | Replaces the primary (swap). Alternative: a separate alt-fire button. |
| 3 | Gamepad layout | Section 10.1 |
| 4 | Mouse scale | 0.2 (5 px/tick = full turn rate); direct mode by default |
| 5 | Firing / ability / pickup ends spawn protection | Yes |
| 6 | Bot backfill target | 6 participants (large arena) |
| 7 | Room size | 8 participants |
| 8 | Browser-safe keys | Brake F, Down Z (+ Ctrl), dodge V |
| 9 | Flight Assist | On by default; X toggles Newtonian |
| 10 | Collision damage | Off |
| 11 | Self-damage from splash | Off |
| 12 | Secondary ammo regeneration | None (respawn + tier top-ups only) |
| 13 | Orange magnet | On, 10 m |
| 14 | Lead pip | On by default |
| 15 | Class switching | At respawn only |
| 16 | Match rules | FFA, 12 kills or 6 minutes |
| 17 | Cloak visibility | Hidden > 60 m (server-enforced), shimmer within |
| 18 | Ship/faction names | Placeholders: Dart, Mule, Scythe, Brute; Fleet, Machine |
| 19 | Auto-level roll | Off by default (setting) |
| 20 | Announcer | Optional, synthesized |

---

## 21. Testing

All headless with Vitest unless noted.

- **Flight controller:**
  - the sign contract (Section 3);
  - each class reaches its max speed within the expected time
    (`maxSpeed / accel` ± 10%);
  - with Assist on and no input, the ship comes to rest;
  - boost multiplies speed by the class factor and drains/regenerates the
    meter at the expected rates;
  - a dodge produces the configured Δv and one full roll.
- **Physics:** a max-boost ram into every wall orientation and into tunnel
  elbows never ends inside geometry (CCD). A Brute pushes a Scythe further
  than the reverse.
- **Determinism:** two Rapier worlds (one in Node, one in a browser runner in
  CI) fed the same blueprint and the same quantized input stream for
  10,000 ticks produce bit-identical own-ship states.
- **Arena generator:** all of the Section 15.2 validations; the room graph is
  connected; ≥ 3 routes per room pair.
- **Combat:**
  - shield → hull routing and overflow;
  - simultaneous lethal hits produce exactly one death;
  - cadence by tick; the volley cap;
  - a volley charges energy once;
  - the lock-warning and missile-warning counters return to 0;
  - torpedoes can be shot down;
  - Bulwark absorbs up to 300 and blocks only frontal shots;
  - cloak breaks on every listed trigger.
- **Lag compensation:** a shot aimed at a target's rewound pose hits, and the
  cap is respected.
- **Power:**
  - tier resolution at 0–10 for every class;
  - drops `ceil(u/2)` for 0–10, split into ≤ 4 pickups;
  - a capped ship doesn't consume;
  - nearest-wins collection;
  - reset on respawn;
  - ammo tops up rather than refilling;
  - the shield ceiling doesn't refill.
- **Netcode harness:** an in-process server + 3 clients over a fake link
  with configurable latency/jitter/loss/reordering. Assert:
  - at 100 ms RTT ± 20 ms jitter, steady-flight p95 own-ship correction
    < 0.3 m;
  - no duplicate kills or pickups;
  - remote interpolation never shows teleports except on discontinuities;
  - a cloaked ship beyond 60 m never appears in another client's snapshots.
- **Soak:** a nightly headless 30-minute match with 8 bots — no crashes, no
  unbounded entity counts, no stuck warnings.
- **Manual playtest checklist per milestone:**
  - KBM and gamepad feel;
  - all 4 classes;
  - Chrome, Firefox, Safari;
  - a laptop on battery;
  - a 4-human online match across regions.

---

## 22. Milestones

Each milestone ends with something playable. Don't start the next until the
current one's exit criteria pass.

**M0 — Skeleton (½–1 day)**
Monorepo, Vite client, Colyseus server stub, Rapier loading in both, Vitest,
CI (lint, typecheck, test, build), static deploy.
*Exit:* the deployed URL loads a spinning procedural cube in < 2 s.

**M1 — Ships and arena (offline flight)**
- the procedural ship builders and the ship-viewer tool (silhouette test passes);
- the arena blueprint, generator, and validation;
- arena rendering with landmark lights, signs, and room PVS;
- the flight controller (Assist on/off, boost, brake, dodge);
- input (KBM, gamepad), both cameras, debug overlay.

*Exit:* all four ships fly through Hollowdeep with distinct, fun handling;
generator and flight tests are green.

**M2 — Offline combat vs bots**
- all primaries, secondaries (lock-on, homing, torpedo HP) and abilities;
- vitals with shield regen; death, debris, and respawn with the class picker;
- match flow, FFA scoring, and spawn selection;
- bots with navigation and class habits;
- HUD, effects, and audio pass 1.

*Exit:* a 6-minute match vs 5 bots is fun with every class, and nothing
blocks play.

**M3 — The orange loop**
Per-class power curves, world population, death drops, the magnet,
collection, alternate primaries, Repel, the power HUD and toasts, bots
valuing power and drops.
*Exit:* all power tests green; kills visibly create bounty swings.

**M4 — Online**
- Colyseus rooms and quickplay with region ping; invite links;
- codecs; clock sync and time dilation;
- own-ship prediction with Rapier replay; remote interpolation;
- predicted firing; lag compensation;
- interest management (cloak), reconnection, bot backfill, version handshake.

*Exit:* the netcode harness passes. 4 humans + bots across regions at
~100 ms RTT feel responsive, with no rubber-banding in steady flight and no
duplicate kills or pickups.

**M5 — "Shippable link" polish**
- quality auto-detect; the < 5 s load target;
- a settings menu (all of Section 10 + audio + accessibility);
- kill feed, hit markers, death cam, post-match podium and stats;
- music; anonymous analytics (sessions, match length, class picks, retention ping).

*Exit:* the Section 0.2 definition of done.

**Later (not v1)**
- a team mode, "Fleet vs Machine";
- more classes (healer/support, rogue);
- utility pickups;
- a second arena via the same blueprint system (or seeded procedural
  blueprints, validated by the same tests);
- leaderboards, mobile touch controls, WebTransport datagrams, spectator mode.
