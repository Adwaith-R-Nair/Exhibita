import { describe, expect, it } from 'vitest';
import { challengeDispute } from '../../src/core/challenge/challenge';
import { evaluateDispute } from '../../src/core/rubric/evaluate';
import { minor, type Dispute, type EvidenceItem } from '../../src/core/types';
import { finalVerdict } from '../../src/core/verdict';

const dispute: Dispute = {
  externalId: 'dp_v', chargeId: 'ch_v', orderId: 'ORD-V', customer: 'cus_v', amount: minor(8900), currency: 'USD',
  processorReason: 'product_not_received', reasonCode: 'visa-13.1', respondBy: '2026-12-04T00:00:00Z',
  receivedAt: '2026-11-20T00:00:00Z', purchasedAt: '2026-10-01T12:00:00Z',
};
const ev = (id: string, type: EvidenceItem['type'], state: string, kind: EvidenceItem['kind'] = 'fact', quote?: string): EvidenceItem => ({
  id, type, state, kind, source: { kind: 'jira', key: id }, at: '2026-10-06T10:00:00Z', ...(quote ? { meta: { quote } } : {}),
});
const verdictFor = (evidence: EvidenceItem[]) => {
  const evaluation = evaluateDispute(dispute, evidence);
  return { evaluation, verdict: finalVerdict(evaluation, challengeDispute(dispute, evidence, evaluation)) };
};

describe('finalVerdict', () => {
  it('allows submission when every item is met and nothing argues against it', () => {
    const { verdict } = verdictFor([ev('POD', 'delivery', 'delivered'), ev('REF', 'refund', 'none')]);
    expect(verdict).toMatchObject({ recommendation: 'fight', canSubmit: true, changed: false });
  });

  it('blocks a complete case once the customer contradicts it (the checklist alone would allow it)', () => {
    const { evaluation, verdict } = verdictFor([
      ev('POD', 'delivery', 'delivered'),
      ev('REF', 'refund', 'none'),
      ev('SUP', 'customer-message', 'denied-receipt', 'inference', 'never arrived'),
    ]);
    expect(evaluation.canSubmit).toBe(true);
    expect(verdict).toMatchObject({ recommendation: 'investigate', canSubmit: false, changed: true });
  });

  it('blocks when evidence is missing, whatever the challenge says', () => {
    const { verdict } = verdictFor([ev('REF', 'refund', 'none')]);
    expect(verdict.canSubmit).toBe(false);
  });

  it('flips to Accept when a refund was approved and never paid', () => {
    const { verdict } = verdictFor([ev('POD', 'delivery', 'delivered'), ev('REF', 'refund', 'approved-not-completed')]);
    expect(verdict).toMatchObject({ recommendation: 'accept', canSubmit: false });
  });
});

describe('finalVerdict while evidence is still being collected', () => {
  it('never allows submission until every source has been read (review A1)', () => {
    const evidence = [ev('POD', 'delivery', 'delivered'), ev('REF', 'refund', 'none')];
    const evaluation = evaluateDispute(dispute, evidence);
    const challenge = challengeDispute(dispute, evidence, evaluation);
    expect(finalVerdict(evaluation, challenge).canSubmit).toBe(true);
    const partial = finalVerdict(evaluation, challenge, { collectionComplete: false });
    expect(partial.canSubmit).toBe(false);
    expect(partial.incomplete).toBe(true);
  });
});
