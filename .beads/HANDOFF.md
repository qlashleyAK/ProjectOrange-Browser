# Beads handoff fallback (for agents with scoped git access)

**If `bd dolt push` fails with 403** — some agent environments (cloud
sessions, sandboxes) scope git credentials to a single branch, and the
board's Dolt remote (`refs/dolt/data`) is outside that scope — **do NOT
recreate the beads with `bd create`** (new IDs break every commit message
and comment that references them). Instead, hand them off:

1. `bd export` the affected beads to JSONL (IDs, comments, status intact).
2. Commit the JSONL to `.beads/handoff/` **on the branch you CAN push**,
   along with a tiny shell script that runs, from a repo checkout with
   normal credentials:
   ```bash
   bd dolt pull
   bd import < .beads/handoff/<file>.jsonl   # upserts by ID: re-run safe
   bd dolt push
   ```
3. Point a commit message at `.beads/handoff/README.md` naming the beads.

**Whoever pushes the board next:** look for `.beads/handoff/` on any
remote branch before/after your push, run any script you find (read it
first), verify with `bd show <id>`, then delete the folder and commit.
`bd import` upserts by ID, so a partially-completed handoff is safe to
re-run; double-imports are harmless.

Precedent: `.beads/handoff/` on `ccr-282871ad-rntce3` (td5 + kvq, imported
2026-11-08 by dzhopa-dream after a 403 from the originating session).