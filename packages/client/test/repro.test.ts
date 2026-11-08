import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateScenario } from '../repro/repro';

const dir = join(import.meta.dirname, '../repro/scenarios');

describe('repro scenarios', () => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    it(`${f} is a valid scenario`, () => {
      const s = validateScenario(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      expect(s.steps.length).toBeGreaterThan(0);
      // every run should end by asserting a clean console
      expect(s.steps.at(-1)!.do).toBe('noErrors');
    });
  }

  it('rejects unknown steps and empty scenarios with a useful message', () => {
    expect(() => validateScenario({ name: 'x', steps: [{ do: 'teleport' }] })).toThrow(/step 1: unknown "do" "teleport"/);
    expect(() => validateScenario({ name: 'x', steps: [] })).toThrow(/non-empty/);
    expect(() => validateScenario({ steps: [{ do: 'wait', ms: 1 }] })).toThrow(/name/);
  });
});
