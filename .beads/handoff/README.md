# Handoff: two beads waiting to reach the Dolt remote

**For the agent picking this up:** push beads `projectorange-browser-td5` and
`projectorange-browser-kvq` to the Dolt remote, then delete this folder.

## Why they're here

A cloud session opened both beads, but couldn't push them. Its git access only
covers its own branch (`ccr-282871ad-rntce3`), and `bd dolt push` to
`refs/dolt/data` came back HTTP 403. The beads exist only in this file until
an agent with normal repo access runs the script.

## What to do

From the repository root, with `bd` installed and your usual git credentials:

```bash
bash .beads/handoff/push-td5-kvq.sh
```

The script:
1. runs `bd dolt pull`;
2. imports both beads from the JSONL embedded in it, keeping their IDs and
   comments (`bd import` upserts by ID, so a re-run is harmless);
3. lists open and in-progress beads;
4. runs `bd dolt push`.

The import was tested against a fresh clone of the remote bead database:
both beads arrived with their IDs, `td5` in progress with both comments, and
`kvq` open. Commit `303a0a6` refers to these IDs, so don't recreate them with
`bd create`, which would give them new IDs.

## Then

- Check: `bd show projectorange-browser-td5` and `bd show projectorange-browser-kvq`.
- Delete `.beads/handoff/` and commit that.

## The beads

- **td5** (P2, in progress): visual fidelity pass covering lighting, shadows,
  shaders and particles. Not ship models. The code is in `303a0a6`, and CI
  passed. Still open: a frame-time check of the High tier (AO + shadows) on a
  real GPU. The cloud session had only a software renderer and couldn't
  measure it.
- **kvq** (P3, open): ship model geometry pass, split out of td5.
