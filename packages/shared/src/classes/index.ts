import { brute } from './brute.js';
import { dart } from './dart.js';
import { mule } from './mule.js';
import { scythe } from './scythe.js';
import type { ClassId, ShipClassDef } from './types.js';

export * from './types.js';
export * from './shipShapes.js';

export const CLASSES: Record<ClassId, ShipClassDef> = { dart, mule, scythe, brute };
export const CLASS_LIST: ShipClassDef[] = [dart, mule, scythe, brute];
export const classByIndex = (i: number): ShipClassDef => CLASS_LIST[i] ?? dart;
