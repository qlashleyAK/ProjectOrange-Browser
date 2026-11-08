# Balance evidence bot

Balance arguments should come with numbers. This bot turns a proposed tuning
change into a bot-vs-bot experiment and posts the result.

## Use it

On any issue or PR, start a comment with:

```
/balance brute hull=220 primary.damage*=1.1
```

Changes are `stat=value`, `stat*=factor` or `stat+=delta`. A stat is any number on
the ship's definition in `packages/shared/src/classes/<ship>.ts`, written as a dotted
path: `hull`, `shield`, `shieldRegenRate`, `maxSpeed.fwd`, `primary.damage`,
`primary.rate`, `secondary.lockTime`, `tiers.3.cadence`, and so on. You can add
`--matches N` (up to 16 from a comment), `--arena hollowdeep|gyre|tower|forest|all`
and `--skill easy|normal|hard`.

Locally the same thing runs as `pnpm balance brute hull=220 --matches 24`. It has no
match cap and also accepts `--seed`, `--out report.md` and `--json results.json`.

## What it measures

Each pair is one seed played twice as a full FFA match: 8 bots, two of each ship,
each pinned to its ship. Run A uses current tuning; run B uses the proposal. The
seed, map and bot brains are the same in both runs, and the sim is deterministic,
so the change is the only systematic difference.

The table shows, per ship, kills, deaths and average placement per match, plus
match wins, as A → B. The last column is the **paired** change in net kills
(kills − deaths) ± its standard error. ✱ marks deltas of at least 2σ.

Read it like this:
- **No ✱ on the changed ship:** the sample can't tell the change from noise. Run more
  matches before arguing about it.
- **✱ on the changed ship:** a real shift in bot play at this sample size. Check the
  other rows to see who pays for it.

Bots aren't players. A ship the bots fly badly can look weak for reasons a human
would fix. The table is evidence for a conversation, not a verdict.

The first run, 3 pairs, showed bot Brutes finishing about 7th of 8 with about 0.5
kills per match, far below every other ship. That's either Brute balance or the
bots' Brute habits. Worth a deeper run (`--matches 24`) before anyone tunes it.

## Cost and safety

A pair takes about 20 s of CPU (two matches of about 10 s each). Eight pairs, the
default, take about 3 minutes on a runner.

The workflow (`.github/workflows/balance.yml`):
- runs only default-branch code, never a PR's code;
- passes the comment to the CLI through an environment variable, never through a shell line;
- validates the comment token by token;
- accepts the command only from owners, members and collaborators.
