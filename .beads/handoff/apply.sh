#!/usr/bin/env bash
# Applies this branch's bead updates to the board (see .beads/HANDOFF.md). Run once, from the repo root.
#  - kvq: imported from JSONL (only this session has touched it; the upsert is safe to re-run)
#  - td5, kx9: comments added rather than imported, because other agents have edited them on the board and an
#    upsert of this session's older copy would drop their comments. Re-running would add the comments twice.
set -euo pipefail
bd dolt pull
bd import .beads/handoff/kvq-claim.jsonl
bd comments add projectorange-browser-td5 "Real-GPU check is one command now: pnpm build && pnpm bench --headed (packages/client/repro/bench.ts, on ccr-282871ad-rntce3 / PR #4). For each map it pauses Practice on one frame and measures Low, Default and High (vsync off): p50/p95 ms, fps, draw calls, triangles, High's multiple of Default. It names the GL renderer and flags SwiftShader, so software runs can't pass as GPU numbers. The cloud session only has SwiftShader. GPU-independent: on a Hollowdeep frame High draws 132 calls vs Default's 112 (+shadow pass, AO) and ~12k more triangles. Close td5 when a --headed run on a real GPU shows High is acceptable; Default carries the 60 fps / 2019 iGPU requirement and doesn't change."
bd update projectorange-browser-kx9 --claim
bd comments add projectorange-browser-kx9 "Root cause found and fixed (PR #4, commit f6afd4f): the flak proximity fuse fired on entry to its 4 m zone, so every shell aimed straight at a ship detonated 4 m short for ~2 splash damage instead of an 18-damage direct hit. It hit humans as much as bots. Bot Brutes landed hits at 20.6% (Darts 15.6%) but did ~2 damage per hit. The fuse now holds while a direct hit is coming and detonates at closest approach otherwise; regression tests are in combat.test.ts. 24-pair A/B master vs fix: Brute damage 308->520, kills 0.6->1.1, place 7.3->6.7, net +0.35+/-0.24 (1.5 sigma). Closer bot engage bands on top raise kills to 2.4 but deaths rise in step (net +0.00+/-0.31), so nothing shipped from that. Still open: Brute survival in close fights (Bulwark timing, retreat) and focus-fire. Balance reports now show damage and direct-hit % per ship. Details: docs/kx9-brute-evidence.md."
bd list --status open,in_progress
bd dolt push
