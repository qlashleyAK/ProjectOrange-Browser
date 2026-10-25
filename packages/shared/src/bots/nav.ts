import type * as RAPIER from '@dimforge/rapier3d-deterministic-compat';
import type { ArenaData } from '../arena/generate.js';
import { moverClearance, segmentClearOfMovers, type Sweep } from '../arena/movers.js';
import { v3, vdist, vnorm, type V3 } from '../math.js';
import { lineOfSight, sphereCastStatic, sphereFree } from '../physicsWorld.js';

export interface NavNode { id: number; pos: V3; place: string; links: number[] }

const CLEAR_R = 5;

export class NavGraph {
  nodes: NavNode[] = [];
  private sweeps: Sweep[];

  constructor(private world: RAPIER.World, arena: ArenaData) {
    this.sweeps = arena.sweeps;
    this.build(arena);
  }

  private add(pos: V3, place: string, requireFree = true): number {
    if (requireFree && (!sphereFree(this.world, pos, CLEAR_R) || moverClearance(this.sweeps, pos) < CLEAR_R + 2)) return -1;
    const id = this.nodes.length;
    this.nodes.push({ id, pos, place, links: [] });
    return id;
  }
  private link(a: number, b: number): void {
    if (a < 0 || b < 0 || a === b) return;
    const na = this.nodes[a]!, nb = this.nodes[b]!;
    if (!na.links.includes(b)) na.links.push(b);
    if (!nb.links.includes(a)) nb.links.push(a);
  }
  private clear(a: V3, b: V3): boolean {
    const d = vdist(a, b);
    if (d < 1e-3) return true;
    const dir = vnorm(v3(), v3(b.x - a.x, b.y - a.y, b.z - a.z));
    return sphereCastStatic(this.world, a, dir, CLEAR_R - 1, d) < 0 && segmentClearOfMovers(this.sweeps, a, b, CLEAR_R);
  }

  private build(arena: ArenaData): void {
    const roomNodes = new Map<string, number[]>();
    for (const r of arena.blueprint.rooms) {
      const ids: number[] = [];
      const c = r.center, s = r.size, grid = r.navGrid;
      const pts: V3[] = [];
      if (grid) {
        const nx = Math.max(1, Math.floor(s.x / grid.step)), nz = Math.max(1, Math.floor(s.z / grid.step));
        for (const y of grid.ys) for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
          pts.push(v3(c.x + (i - (nx - 1) / 2) * grid.step, c.y + y, c.z + (k - (nz - 1) / 2) * grid.step));
        }
      } else {
        pts.push(v3(c.x, c.y, c.z));
        for (const fx of [-0.28, 0.28]) for (const fz of [-0.28, 0.28]) for (const fy of [-0.22, 0.22]) {
          pts.push(v3(c.x + s.x * fx, c.y + s.y * fy, c.z + s.z * fz));
        }
        if (s.y > 150) for (const fy of [-0.42, -0.2, 0.2, 0.42]) for (const [fx, fz] of [[0.32, 0], [-0.32, 0], [0, 0.32], [0, -0.32]] as const) {
          pts.push(v3(c.x + s.x * fx, c.y + s.y * fy, c.z + s.z * fz));
        }
      }
      for (const p of pts) {
        let id = this.add(p, r.id);
        if (id < 0 && grid) {
          // a quarter step to either side, so the grid stays regular
          const q = grid.step / 4;
          for (const [dx, dz] of [[q, 0], [-q, 0], [0, q], [0, -q]] as const) {
            id = this.add(v3(p.x + dx, p.y, p.z + dz), r.id);
            if (id >= 0) break;
          }
        } else if (id < 0) {
          // nudge toward the walls/center until free
          for (const k of [0.8, 1.2, 0.6, 1.4]) {
            id = this.add(v3(c.x + (p.x - c.x) * k, p.y, c.z + (p.z - c.z) * k), r.id);
            if (id >= 0) break;
          }
        }
        if (id >= 0) ids.push(id);
      }
      roomNodes.set(r.id, ids);
    }
    // doorways: a node just inside the room and one at the door plane
    const doorNodes = new Map<string, { inner: number; door: number }>();
    for (const d of arena.doorways) {
      const inner = this.add(v3(d.center.x + d.inward.x * 14, d.center.y + d.inward.y * 14, d.center.z + d.inward.z * 14), d.room.id, false);
      const door = this.add({ ...d.center }, d.tunnel.id, false);
      this.link(inner, door);
      roomNodes.get(d.room.id)!.push(inner);
      doorNodes.set(d.id, { inner, door });
    }
    // tunnels: door a -> elbows -> door b
    for (const t of arena.blueprint.tunnels) {
      let prev = doorNodes.get(`${t.id}:a`)!.door;
      for (let i = 1; i < t.path.length - 1; i++) {
        const e = this.add({ ...t.path[i]! }, t.id, false);
        this.link(prev, e);
        prev = e;
      }
      this.link(prev, doorNodes.get(`${t.id}:b`)!.door);
    }
    // in-room visibility links (grid rooms only link near neighbors)
    for (const [rid, ids] of roomNodes) {
      const grid = arena.blueprint.rooms.find((r) => r.id === rid)!.navGrid;
      const reach = grid ? grid.step * (grid.reach ?? 2.9) : Infinity;
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = this.nodes[ids[i]!]!, b = this.nodes[ids[j]!]!;
        if (vdist(a.pos, b.pos) <= reach && this.clear(a.pos, b.pos)) this.link(a.id, b.id);
      }
    }
  }

  nearestVisible(pos: V3, maxChecks = 10): number {
    const sorted = this.nodes.map((n) => ({ n, d: vdist(n.pos, pos) })).sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(maxChecks, sorted.length); i++) {
      if (lineOfSight(this.world, pos, sorted[i]!.n.pos)) return sorted[i]!.n.id;
    }
    return sorted[0]?.n.id ?? -1;
  }

  /** A* between nearest visible nodes; returns waypoint positions ending at `to`. */
  path(from: V3, to: V3): V3[] {
    if (lineOfSight(this.world, from, to) && this.clear(from, to)) return [to];
    const s = this.nearestVisible(from), g = this.nearestVisible(to);
    if (s < 0 || g < 0) return [to];
    const open = new Set<number>([s]);
    const came = new Map<number, number>();
    const gScore = new Map<number, number>([[s, 0]]);
    const fScore = new Map<number, number>([[s, vdist(this.nodes[s]!.pos, this.nodes[g]!.pos)]]);
    while (open.size) {
      let cur = -1, bestF = Infinity;
      for (const o of open) { const f = fScore.get(o) ?? Infinity; if (f < bestF) { bestF = f; cur = o; } }
      if (cur === g) break;
      open.delete(cur);
      const cn = this.nodes[cur]!;
      for (const nb of cn.links) {
        const tg = (gScore.get(cur) ?? Infinity) + vdist(cn.pos, this.nodes[nb]!.pos);
        if (tg < (gScore.get(nb) ?? Infinity)) {
          came.set(nb, cur); gScore.set(nb, tg);
          fScore.set(nb, tg + vdist(this.nodes[nb]!.pos, this.nodes[g]!.pos));
          open.add(nb);
        }
      }
    }
    if (!came.has(g) && s !== g) return [to];
    const ids: number[] = [g];
    while (ids[0] !== s) { const p = came.get(ids[0]!); if (p === undefined) break; ids.unshift(p); }
    return [...ids.map((i) => this.nodes[i]!.pos), to];
  }

  randomRoomNode(rng: { int(lo: number, hi: number): number }, place?: string): V3 {
    const pool = place ? this.nodes.filter((n) => n.place === place) : this.nodes;
    return (pool.length ? pool : this.nodes)[rng.int(0, pool.length || this.nodes.length)]!.pos;
  }
}
