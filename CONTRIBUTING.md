# Contributing to Project Orange

Thanks for wanting to help — here's how the place works.

## The short version

1. **Bugs, balance, and ideas** → [issues](https://github.com/qlashleyAK/ProjectOrange-Browser/issues),
   with the matching template. Be concrete; we replay bugs headlessly, so
   details (ship, map, build, steps) are gold.
2. **Code** → PRs against `master`. CI runs the whole gate on every PR:
   typecheck, full test suite, build, and a 3-minute bot soak.
3. **Balance changes go through the sim, not the forum.** Comment
   `/balance <ship> <stat>=<value>` on any issue or PR and a paired
   bot-vs-bot A/B sim posts evidence tables back. Balance PRs without
   sim evidence don't get merged — numbers first, opinions second.

## Working in the repo

```bash
pnpm install
pnpm dev          # client, offline vs bots works with no server
pnpm dev:server   # local room server for multiplayer
pnpm typecheck    # run this FIRST — it's fast and catches most mistakes
pnpm test         # full suite (~5 min)
pnpm soak 3       # sim soak: perf check vs docs/soak-headroom.md
```

Conventions that keep the code fast to review:

- **One PR, one thing.** A feature and its drive-by lint fixes are two PRs.
- **Deterministic everything.** The sim is seeded and shared by client,
  server, and bots — if your change adds randomness, it goes through the
  seeded RNG or it's a bug.
- **No new runtime dependencies** without discussion. The whole game is
  <5 MB and built on three.js + Rapier + ws + Vite; we intend to keep it
  that way.
- Tests live next to the package they cover (`packages/*/test/`). If you
  touched the sim or match flow, add or extend one — the deterministic
  sim makes most game-logic tests fast and painless.

## Task board

The repo's issue tracker for *work in progress* is
[Dolt-backed](.beads/README.md): `npm i -g @beads/bd && bd bootstrap` after
cloning, `bd ready --claim` to pick something up. External contributions
don't need the board — PRs are welcome as-is.

## Conduct

Be decent. Trash talk belongs in the arena, not the issue queue.
