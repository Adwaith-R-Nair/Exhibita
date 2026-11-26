import { describe, expect, it } from 'vitest';
import { asDisputeRecord, canonicalJson, reconcileRecord, RECORD_SCHEMA_VERSION, type DisputeRecord } from '../../src/core/record';
import { minor } from '../../src/core/types';

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

describe('canonicalJson', () => {
  it('ignores key order but not values', () => {
    expect(canonicalJson({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(canonicalJson({ b: [1, { x: 1, y: 2 }], a: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('reconcileRecord', () => {
  const stored = { ...valid, dispute: { ...valid.dispute, amount: minor(8900) } } as unknown as DisputeRecord;
  const forged = { ...stored, evidence: [{ id: 'x', type: 'delivery', state: 'delivered' }] } as unknown as DisputeRecord;

  it('trusts the stored copy when the work item copy matches it', () => {
    const copy = JSON.parse(JSON.stringify(stored)) as DisputeRecord;
    expect(reconcileRecord(stored, copy)).toEqual({ trust: 'verified', record: stored });
  });

  it('uses the stored copy and flags it when the work item copy was edited', () => {
    expect(reconcileRecord(stored, forged)).toEqual({ trust: 'copy-changed', record: stored });
  });

  it('uses the stored copy and flags it when the work item copy was removed', () => {
    expect(reconcileRecord(stored, null)).toEqual({ trust: 'copy-changed', record: stored });
  });

  it('never trusts a work item copy that Exhibita did not store', () => {
    expect(reconcileRecord(null, forged)).toEqual({ trust: 'unverified', record: null });
  });

  it('reports no record when neither copy exists', () => {
    expect(reconcileRecord(null, null)).toEqual({ trust: 'none', record: null });
  });
});
