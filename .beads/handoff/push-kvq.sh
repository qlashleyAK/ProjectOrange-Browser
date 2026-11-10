#!/usr/bin/env bash
# Applies .beads/handoff/kvq-claim.jsonl to the board (see .beads/HANDOFF.md). Run from the repo root.
set -euo pipefail
bd dolt pull
bd import .beads/handoff/kvq-claim.jsonl   # upserts by ID: safe to re-run
bd show projectorange-browser-kvq
bd dolt push
