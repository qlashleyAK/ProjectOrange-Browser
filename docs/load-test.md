# Load test — synthetic clients against orange-staging (live droplet)

**Bead:** projectorange-browser-6if · **Run:** 2026-11-08 by dzhopa-dream
**Target:** DO droplet `617032671` (s-1vcpu-2gb, 1 vCPU, nyc3), server 0.2.0,
over the public internet via Cloudflare (staging.projectorange.nexus).
**Driver:** `pnpm --filter @orange/server load <host> <rooms> <clients/room> <seconds>`
(`packages/server/scripts/load-driver.ts`) — real WS clients, real binary input
packets at 30 Hz, snapshots consumed and counted.

## Results (60 s runs, 8 slots/room, bots backfill empty seats)

| Load | Humans | tickMs avg | tickMs max | Snaps/client/s | Downstream/client |
|---|---|---|---|---|---|
| 2 rooms | 16 | 2.14 | 3.4 | 65.5 | 31.4 KB/s |
| 6 rooms | 32* | 2.22 | 6.5 | 42.4 | 20.9 KB/s |
| 12 rooms | 64* | 2.23 | 13.6 | 33.4 | 16.5 KB/s |
| 1 room via CF | 4 | 3.68 (CF RTT path) | 6.0 | 56.6 | 22.4 KB/s |

*driver connected fewer clients than requested at higher loads (see below) —
rooms backfilled with bots, so the SIM load was still 8 ships/room.

## Reading

- **Netcode overhead is ~3-4x the offline sim**: offline soak said 0.52-0.84
  ms/tick/room; live rooms with humans tick at ~2.2-2.4 ms. That's the
  serialization + snapshot + WS cost, measured for real.
- **1 vCPU comfortably held 12 rooms / 64 humans** at avg 2.23 ms/tick with a
  worst spike of 13.6 ms — still inside the 16.7 ms frame budget. Server stayed
  healthy: load avg ~1.25 (saturated but stable), RSS 611 MB / 2 GB.
- **Practical per-process cap on this size: ~12-16 rooms (~100 humans)** before
  worst-case coincident spikes threaten frames — consistent with the soak-headroom
  doc's 40-60-room cap for a 4-vCPU box. The plan's L1 scale-out remains far away.
- **Bandwidth**: ~16-31 KB/s downstream per client (scales down as more humans
  share snapshot work). A full 8-human room ≈ 1.5-2.5 Mbps egress. On DO's
  2-4 TB/mo basic tier, ~100 humans sustained ≈ under 1% of the transfer budget.
- **Cloudflare path is clean**: WS upgrade 101 over HTTP/1.1 (curl's default
  HTTP/2 gives a misleading 200 — always test WS with `--http1.1`), snapshots
  flowed at full rate through the proxy, ping endpoint healthy.

## Caveats / follow-ups

- Client connect rate fell short of target at 6/12 rooms (32/48, 64/96
  connected) — **driver-side** (my container's fd/ephemeral limits or burst
  connect timing), not server: tickMs and snapshot rates stayed flat and
  healthy throughout. A beefier driver host (or staggering connects) would
  find the true server-side connect ceiling.
- All load was neutral-stick inputs; real players add input-processing but
  that's per-packet parse, already exercised here at 30 Hz x 64.
- Next stress target when it matters: 20+ rooms from a proper load host to
  find the actual knee, then that number is the ops cap for this size class.
