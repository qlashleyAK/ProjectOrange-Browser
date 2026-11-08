import * as THREE from 'three';
import { CHECKPOINT_RADIUS, type V3 } from '@orange/shared';

const TEAL = 0x5affdc;

/**
 * Mine-run course: one ring per checkpoint, sized to the pass-through radius. The next ring is bright and
 * pulsing, the one after it is a dim preview of the line, passed rings disappear. Rings face along the course.
 */
export class CheckpointRenderer {
  private group = new THREE.Group();
  private rings: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = [];
  private geo = new THREE.TorusGeometry(CHECKPOINT_RADIUS, 0.7, 8, 64);
  private key = '';

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** `next`: index of the local pilot's next checkpoint (course.length = finished). */
  update(course: V3[], next: number, time: number): void {
    const key = course.map((p) => `${p.x},${p.y},${p.z}`).join('|');
    if (key !== this.key) this.rebuild(course, key);
    const pulse = 0.75 + 0.25 * Math.sin(time * 5);
    this.rings.forEach((r, i) => {
      r.visible = i === next || i === next + 1;
      r.material.opacity = i === next ? 0.9 * pulse : 0.22;
      const s = i === next ? 1 + 0.04 * Math.sin(time * 5) : 1;
      r.scale.setScalar(s);
    });
  }

  private rebuild(course: V3[], key: string): void {
    this.key = key;
    for (const r of this.rings) { this.group.remove(r); r.material.dispose(); }
    this.rings = course.map((p, i) => {
      const m = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({
        color: TEAL, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      }));
      m.position.set(p.x, p.y, p.z);
      // face along the line: from the previous checkpoint into this one (the first faces the second)
      const from = course[i - 1] ?? null, to = from ? p : course[i + 1] ?? null;
      const a = from ?? p;
      if (to && (to.x !== a.x || to.y !== a.y || to.z !== a.z)) m.lookAt(m.position.clone().add(new THREE.Vector3(to.x - a.x, to.y - a.y, to.z - a.z)));
      this.group.add(m);
      return m;
    });
  }

  clear(): void { this.update([], 0, 0); }
}
