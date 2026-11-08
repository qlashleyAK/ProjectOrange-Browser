# Staging runbook — orange-staging droplet

**Live since:** 2026-11-08 · **URL:** https://staging.projectorange.nexus
(Cloudflare-proxied, edge TLS; origin Caddy self-signed on 443 under zone SSL
mode Full. Direct IP http://45.55.189.32 still works for debugging.)
**Droplet:** `617032671` · orange-staging · nyc3 · `s-1vcpu-2gb` (~$12/mo) · Ubuntu 24.04
**Tags:** `orange-staging` `dzhopa-dream` `destroyable`
**SSH key:** `dzhopa-dream-orange-staging` (ed25519) in the DO account; private half
sealed at `/opt/data/.do/staging_ed25519` on the dzhopa-dream host. Root@ only.

## What runs there

- Node 22 (cloud-init / NodeSource) — needed for `node:sqlite` (logs an
  ExperimentalWarning; harmless, watch it across Node upgrades).
- Caddy (Ubuntu repo): `staging.projectorange.nexus` block, `tls internal`,
  reverse_proxy 127.0.0.1:8080. CF connects over 443 (zone SSL mode: Full,
  non-strict accepts the self-signed origin cert).
- `/opt/orange/server-dist/index.js` — esbuild bundle, no node_modules on the box.
- `/opt/orange/client-dist/` — static client (served by the same process).
- `/opt/orange/data/orange.db` — SQLite (WAL). Persisted state: nothing yet; it's
  recreated empty on redeploy if deleted.
- systemd unit `orange-staging` (PORT=8080, REGION=nyc3; Caddy owns 80/443) —
  restarts on crash, enabled at boot.

## Deploy (from any machine with the repo)

```bash
pnpm install && pnpm build
mkdir -p pkg && cp -r packages/server/dist pkg/server-dist && cp -r packages/client/dist pkg/client-dist
tar -czf orange-staging.tar.gz -C pkg server-dist client-dist
scp -i <key> orange-staging.tar.gz root@<droplet-ip>:/opt/orange/
ssh -i <key> root@<droplet-ip> 'cd /opt/orange && tar xzf orange-staging.tar.gz && systemctl restart orange-staging'
```

No credentials ever live on the droplet — it ships a built artifact, never the
repo or any token. (Repo goes public before launch anyway, but keep the habit.)

## Verify

- `curl https://staging.projectorange.nexus/ping` → `{ok:true, region:"nyc3", ...}`
- `curl http://<ip>/quickplay` → room assignment
- `curl http://<ip>/api/leaderboard?window=week` → rows (empty until matches finish)
- `curl http://<ip>/api/daily` → today's rotating mode + seed (deterministic)
- WebSocket: `wss?://<ip>/ws` upgrades 101

## Destroy / audit

- API: `DELETE /v2/droplets/617032671` (cost stops immediately; per-second billing)
- Console: tag filter `orange-staging`
- Nothing else was created: no volumes, snapshots, load balancers, or managed DBs.

## Open follow-ups

- [x] staging.projectorange.nexus → this box (Cloudflare proxied, 2026-11-08).
      Root projectorange.nexus still routes to the old demo Worker
      (demo-game-001) — replacing it is an owner decision, pending.
- [ ] Origin TLS hardening: swap Caddy self-signed for a CF Origin CA cert
      (enables Full (strict)).
- [ ] Soak-headroom re-run on this droplet (`v5r`): the box has no source checkout
      by design; either run the soak from a checkout elsewhere against the same
      instance class, or accept the container baseline + the synthetic-client load
      test (`6if`) as the real numbers.
- [x] HTTPS at the edge (Cloudflare) — done 2026-11-08. WS verified through CF
      (HTTP/1.1 upgrade 101; curl over h2 shows a misleading 200).
