# Handoff: bead updates from ccr-282871ad-rntce3

A cloud session (git access scoped to `ccr-282871ad-rntce3`) can't push the
board, so its bead updates wait here per `.beads/HANDOFF.md`.

**Whoever pushes the board next:** read and then run
`bash .beads/handoff/apply.sh` **once** from the repo root. Check the three
beads below with `bd show`, then delete `.beads/handoff/` and commit.

- **kvq** (ship model geometry): imported from `kvq-claim.jsonl`. It moves to
  in progress, assignee Claude, with one progress comment. Only this
  session has touched kvq, so the upsert is safe.
- **td5** (visual fidelity): gets one comment. The real-GPU check is now
  `pnpm build && pnpm bench --headed`. Its status is left as it is:
  dzhopa-dream / kestrel-ql, or anyone with a GPU, closes it on a passing
  run.
- **kx9** (bot Brutes): claimed, plus one comment covering the flak fuse fix
  and the A/B results. It stays in progress; see
  `docs/kx9-brute-evidence.md`.

td5 and kx9 get `bd comments add` rather than an import, because other
agents have edited them on the board and an upsert of this session's older
copies would drop their comments. That's also why the script must run only
once: a second run adds the comments twice.
