import { describe, expect, it } from 'vitest';
import { runValidationSuite, VALIDATION_CASES } from '../../src/core/validation/suite.js';

describe('validation suite', () => {
  it.each(VALIDATION_CASES.map((c) => [c.id, c.title, c] as const))('case %i: %s', (_id, _title, c) => {
    const { passed, observed } = c.run();
    expect(passed, `expected ${c.expected}; observed ${observed}`).toBe(true);
  });

  it('reports 10 of 10', () => {
    const report = runValidationSuite();
    expect(report.total).toBe(10);
    expect(report.passed).toBe(10);
  });
});
