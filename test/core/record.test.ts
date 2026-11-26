import { describe, expect, it } from 'vitest';
import { asDisputeRecord, RECORD_SCHEMA_VERSION } from '../../src/core/record.js';
import { minor } from '../../src/core/types.js';

const valid = {
  schemaVersion: RECORD_SCHEMA_VERSION,
  dispute: { externalId: 'dp_1', amount: 100 },
  evidence: [],
  raw: {},
  collectedAt: null,
};

describe('asDisputeRecord', () => {
  it('accepts a record of the current schema version', () => {
    expect(asDisputeRecord(valid)).toBe(valid);
  });

  it.each([
    ['null', null],
    ['a string', 'exhibita'],
    ['an older schema version', { ...valid, schemaVersion: 0 }],
    ['a missing dispute', { ...valid, dispute: null }],
    ['evidence that is not a list', { ...valid, evidence: {} }],
  ])('rejects %s', (_label, value) => {
    expect(asDisputeRecord(value)).toBeNull();
  });
});

describe('minor', () => {
  it('rejects fractional cents', () => {
    expect(() => minor(12.5)).toThrow(RangeError);
    expect(minor(1250)).toBe(1250);
  });
});
