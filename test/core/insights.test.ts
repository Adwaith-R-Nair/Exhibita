import { describe, expect, it } from 'vitest';
import { whyWeLose } from '../../src/core/insights';
import type { OutcomeRow } from '../../src/core/sources/types';
import { minor } from '../../src/core/types';

const row = (i: number, reasonCode: OutcomeRow['reasonCode'], result: OutcomeRow['result'], lossReason: string | null, cents = 20000): OutcomeRow => ({
  disputeId: `dp_${i}`, reasonCode, amount: minor(cents), currency: 'USD', decision: result === 'accepted' ? 'accepted' : 'fought', result, closedAt: '2026-06-01T00:00:00Z', lossReason,
});

const outcomes: OutcomeRow[] = [
  ...Array.from({ length: 18 }, (_, i) => row(i, 'visa-13.1', 'lost', 'No signed proof of delivery on an order over $150')),
  ...Array.from({ length: 4 }, (_, i) => row(100 + i, 'visa-13.1', 'lost', 'Tracking did not show delivery')),
  ...Array.from({ length: 10 }, (_, i) => row(200 + i, 'visa-13.1', 'won', null)),
  ...Array.from({ length: 6 }, (_, i) => row(300 + i, 'visa-13.3', 'lost', 'The complaint was not answered')),
  row(400, 'visa-13.2', 'accepted', null),
];

describe('whyWeLose', () => {
  const insights = whyWeLose(outcomes);

  it('names the most common reason fought disputes were lost, with counts, never a rate or prediction', () => {
    expect(insights[0]).toMatchObject({ reasonCode: 'visa-13.1', lossReason: 'No signed proof of delivery on an order over $150', count: 18, lostForReason: 22 });
    expect(insights[0]!.sentence).toBe('18 of 22 lost Item not received disputes: No signed proof of delivery on an order over $150.');
    for (const i of insights) expect(i.sentence).not.toMatch(/%|likely|chance|probab/i);
  });

  it('ranks by how often, then by money lost, and ignores wins and accepted disputes', () => {
    expect(insights.map((i) => i.count)).toEqual([18, 6, 4]);
    expect(insights.some((i) => i.reasonCode === 'visa-13.2')).toBe(false);
  });

  it('says nothing when there are no losses', () => {
    expect(whyWeLose(outcomes.filter((o) => o.result !== 'lost'))).toEqual([]);
  });
});
