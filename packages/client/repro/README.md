# Headless repro harness

Plays a scripted scenario against the real client in headless Chromium and says
whether a bug reproduces. The game runs fully offline against bots, so most
client bugs can be reproduced without a GPU or a second player.

```bash
pnpm build                          # once, or pass --build
pnpm repro practice-smoke           # a name from repro/scenarios, or a path
pnpm repro my-bug.json --url https://staging.projectorange.nexus
```

The harness starts the real game server on a free port (built client, in-memory
database), so both **Practice vs bots** and **Quick Play** work. `--url` targets a
deployed build instead. Use this to check a report against the exact
`BUILD_VERSION` the player had.

| exit | verdict | meaning |
|---|---|---|
| 0 | NOT REPRODUCED | every expectation held, no page errors |
| 1 | REPRODUCED | an `expect` failed, a `waitFor` timed out, or the page threw |
| 2 | harness error | bad scenario, server or browser didn't start |

`pnpm repro` reports any failure as exit 1. Automation that needs to tell a
reproduction apart from a broken run (the triager) should call
`packages/client/node_modules/.bin/tsx packages/client/repro/repro.ts …` directly
to get the exact 0/1/2 code.

Artifacts go to `repro-out/<scenario>-<time>/`:
- `transcript.md`: paste-ready for the issue: build, browser, every step with ✅/❌ and the game state after it, the verdict
- `probe.jsonl`: game state once a second and after each step
- `console.log`: the full browser console
- numbered screenshots

## Writing a scenario

A scenario describes **correct** behavior. A bug report becomes a scenario whose
expectation fails until the bug is fixed. After the fix it doubles as a regression check.

```json
{
  "name": "Mule spawns with full hull after a death",
  "settings": { "lastClass": "mule", "botSkill": "hard" },
  "steps": [
    { "do": "waitFor", "until": "p.menu === 'main'", "timeoutMs": 60000 },
    { "do": "click", "text": "Practice vs bots" },
    { "do": "waitFor", "until": "p.alive === true && p.phase === 'inProgress'", "timeoutMs": 60000 },
    { "do": "waitFor", "until": "p.deaths >= 1 && p.alive === true", "timeoutMs": 240000 },
    { "do": "expect", "that": "p.hull === 130", "label": "respawn restores hull" },
    { "do": "noErrors" }
  ]
}
```

| step | does |
|---|---|
| `click` `text` | clicks the visible button whose label starts with `text` |
| `focus` | clicks the canvas, which grants pointer lock so mouse look and firing work |
| `waitFor` `until` `timeoutMs?` | polls until the expression is truthy; a timeout stops the run |
| `expect` `that` `label?` | the expression must be truthy |
| `mark` `as` | saves the current state as `m.<as>` for later expressions |
| `hold` `keys` `ms` | holds `KeyboardEvent.code` keys together (`KeyW`, `ShiftLeft`, `Space`, …) |
| `press` `key` | taps one key (`Escape`, `KeyG`, `Digit2`, …) |
| `look` `dx` `dy` `ms?` | mouse look by pixels (needs `focus` first) |
| `fire` `ms` `button?` | holds `left` (primary) or `right` (lock / secondary) |
| `wait` `ms` · `screenshot` `name` · `noErrors` | pause, capture, assert a clean console |

Expressions are JavaScript evaluated in the page, with these names in scope:
- `p`: `window.orange.probe()` (see `packages/client/src/main.ts`), with fields `version`, `mode`
  (`menu`/`practice`/`quick`/`private`), `menu` (open screen or null), `arena`, `phase`, `alive`,
  `classId`, `hull`, `shield`, `power`, `tier`, `pos`, `speed`, `kills`, `deaths`, `ships`, `bots`,
  `humans`, `fps`, `ping`, `paused`, `pointerLocked`, …
- `m`: states saved by `mark`
- `dist(a, b)`: metres between two positions

Top-level options:
- `settings`: merged into the saved settings before load. Defaults are low quality, muted and no first-visit flow.
- `query`: for example `"?room=ABCDE"`.
- `viewport`: default `[1280, 720]`.
- `allowConsoleErrors`: regexes for console noise this scenario should ignore.

## Limits: headless runs are slower than real hardware

Chromium renders WebGL here through SwiftShader, on the CPU. On a 4-core machine
(a GitHub runner, or this repo's cloud sessions), the raster threads take most of
the CPU, so the sim worker and the socket handlers run late. Measured: the
worker-to-page link read 0.7–3 s and the frame rate fell to 10–30 fps.

UI flows, menus, HUD state, spawns, crashes and console errors reproduce
faithfully. Flight timing does not always. A "hold W for 2 s" check can fail
because the starved worker never applied the inputs. Assert outcomes with slack,
such as `dist(p.pos, m.start.pos) > 15` rather than an exact speed. Treat
`practice-flight` as reliable only on a GPU or a fast machine. CI runs
`practice-smoke`, which avoids timing-sensitive checks.

`CHROMIUM_PATH` overrides the browser binary. Otherwise `playwright-core` uses
its own Chromium (`pnpm --filter @orange/client exec playwright-core install chromium`).
