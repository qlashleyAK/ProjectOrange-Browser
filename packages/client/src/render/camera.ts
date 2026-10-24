import * as THREE from 'three';
import { sphereCastStatic, type RAPIER, type ShipClassDef } from '@orange/shared';
import { settings } from '../settings';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Third/first-person camera with smoothing, wall collision, trauma shake and speed FOV. */
export class CameraRig {
  firstPerson = !settings.thirdPerson;
  trauma = 0;
  private smoothQ = new THREE.Quaternion();
  private initialized = false;
  private shakeT = 0;
  private boostFov = 0;
  private dist = 0;
  /** death cam */
  private deathLook: THREE.Vector3 | null = null;
  private deathFrom = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {}

  addTrauma(t: number): void { if (settings.cameraShake) this.trauma = Math.min(1, this.trauma + t); }

  reset(): void { this.initialized = false; this.deathLook = null; }

  /** Follow a ship. Returns the horizontal FOV to use. */
  follow(dt: number, pos: THREE.Vector3, rot: THREE.Quaternion, vel: THREE.Vector3, def: ShipClassDef, boosting: boolean, world: RAPIER.World | null): number {
    this.deathLook = null;
    const L = def.size.z;
    if (!this.initialized) { this.smoothQ.copy(rot); this.initialized = true; this.dist = 2.2 * L; }
    if (this.firstPerson) {
      this.smoothQ.copy(rot);
      _v.set(def.cockpit.x, def.cockpit.y, def.cockpit.z).applyQuaternion(rot).add(pos);
      this.camera.position.copy(_v);
      this.camera.quaternion.copy(rot);
    } else {
      // rotation follows with exponential smoothing; roll is followed at 60% weight
      const k = 1 - Math.exp(-6 * dt);
      this.smoothQ.slerp(rot, k);
      const fwd = _v.set(0, 0, -1).applyQuaternion(this.smoothQ);
      const shipUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.smoothQ);
      const prevUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      prevUp.addScaledVector(fwd, -prevUp.dot(fwd)).normalize();
      const up = prevUp.lerp(shipUp, 0.6 + 0.4 * (1 - Math.exp(-3 * dt))).normalize();
      const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd, up);
      const camQ = new THREE.Quaternion().setFromRotationMatrix(m);

      const offset = new THREE.Vector3(0, 0.35 * L, 2.2 * L).applyQuaternion(camQ);
      let want = offset.length();
      const dir = offset.clone().normalize();
      if (world) {
        const hit = sphereCastStatic(world, { x: pos.x, y: pos.y, z: pos.z }, { x: dir.x, y: dir.y, z: dir.z }, 0.6, want);
        if (hit >= 0) want = Math.max(1.5, hit - 0.3);
      }
      // pull in fast, ease back out
      this.dist = want < this.dist ? want : this.dist + (want - this.dist) * (1 - Math.exp(-4 * dt));
      this.camera.position.copy(pos).addScaledVector(dir, this.dist);
      const target = pos.clone().addScaledVector(fwd, L * 2);
      this.camera.up.copy(up);
      this.camera.lookAt(target);
    }
    this.applyShake(dt);
    const speed = vel.length();
    const maxS = def.maxSpeed.fwd * def.boostSpeedMult;
    const wantBoost = boosting ? 8 : 8 * Math.max(0, (speed - def.maxSpeed.fwd) / Math.max(1, maxS - def.maxSpeed.fwd));
    this.boostFov += (wantBoost - this.boostFov) * (1 - Math.exp(-4 * dt));
    return settings.fov + this.boostFov;
  }

  /** Spectate: look at a target (killer) from near the death point, or slowly orbit it. */
  deathCam(dt: number, deathPos: THREE.Vector3, killerPos: THREE.Vector3 | null, t: number): number {
    if (!this.deathLook) {
      this.deathLook = deathPos.clone();
      this.deathFrom.copy(this.camera.position);
    }
    if (killerPos) this.deathLook.lerp(killerPos, 1 - Math.exp(-5 * dt));
    else {
      const a = t * 0.25;
      this.camera.position.lerp(_v.set(deathPos.x + Math.cos(a) * 30, deathPos.y + 10, deathPos.z + Math.sin(a) * 30), 1 - Math.exp(-1.5 * dt));
    }
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.deathLook);
    this.applyShake(dt);
    return settings.fov;
  }

  private applyShake(dt: number): void {
    this.trauma = Math.max(0, this.trauma - 1.5 * dt);
    if (this.trauma <= 0 || !settings.cameraShake) return;
    this.shakeT += dt;
    const s = this.trauma * this.trauma;
    const n = (o: number) => Math.sin(this.shakeT * 37 + o) * 0.6 + Math.sin(this.shakeT * 71 + o * 2.3) * 0.4;
    const ang = s * 0.045;
    _q.setFromEuler(new THREE.Euler(n(0) * ang, n(10) * ang, n(20) * ang * 0.6));
    this.camera.quaternion.multiply(_q);
    this.camera.position.add(_v.set(n(30), n(40), n(50)).multiplyScalar(s * 0.35));
  }
}
