// The ten-case validation suite (docs/SPEC.md §7). Each case builds a small synthetic dispute, runs the
// real engine (rubric, challenge, clustering) and checks one behaviour. The same module runs in the
// unit tests and behind the "Run validation suite" button, so what CI proves is what an admin sees.

import { challengeDispute } from '../challenge/challenge.js';
import { clusterDisputes, type DisputeCase } from '../cluster/cluster.js';
import { evaluateDispute } from '../rubric/evaluate.js';
import { minor, type Dispute, type EvidenceItem, type EvidenceMeta, type EvidenceType } from '../types.js';

export interface ValidationCase {
  id: number;
  title: string;
  expected: string;
  run: () => { passed: boolean; observed: string };
}

export interface ValidationReport {
  passed: number;
  total: number;
  results: { id: number; title: string; expected: string; observed: string; passed: boolean }[];
}

const RECEIVED = '2026-11-20T00:00:00Z';
const PURCHASED = '2026-10-01T12:00:00Z';

function fixtures() {
  let n = 0;
  const ev = (type: EvidenceType, state: string, key: string, extra: { kind?: 'fact' | 'inference'; meta?: EvidenceMeta; at?: string } = {}): EvidenceItem => ({
    id: `v${++n}`,
    type,
    state,
    kind: extra.kind ?? 'fact',
    source: { kind: 'jira', key },
    at: extra.at ?? '2026-10-06T10:00:00Z',
    ...(extra.meta ? { meta: extra.meta } : {}),
  });
  const dispute = (reasonCode: string, dollars: number, externalId = 'dp_val'): Dispute => ({
    externalId,
    chargeId: 'ch_val',
    orderId: 'ORD-VAL',
    customer: 'cus_val',
    amount: minor(Math.round(dollars * 100)),
    currency: 'USD',
    processorReason: 'validation',
    reasonCode,
    respondBy: '2026-12-04T00:00:00Z',
    receivedAt: RECEIVED,
    purchasedAt: PURCHASED,
  });
  const full = (d: Dispute, evidence: EvidenceItem[]) => {
    const evaluation = evaluateDispute(d, evidence);
    return { evaluation, challenge: challengeDispute(d, evidence, evaluation) };
  };
  return { ev, dispute, full };
}

export const VALIDATION_CASES: readonly ValidationCase[] = [
  {
    id: 1,
    title: 'Strong case, all evidence present',
    expected: 'Fight, Strong, submit allowed',
    run: () => {
      const { ev, dispute, full } = fixtures();
      const { challenge, evaluation } = full(dispute('visa-13.1', 89), [
        ev('delivery', 'delivered', 'ORD-VAL'),
        ev('refund', 'none', 'ORD-VAL'),
        ev('customer-message', 'acknowledged-receipt', 'SUP-1', { kind: 'inference' }),
      ]);
      return {
        passed: challenge.recommendation === 'fight' && evaluation.coverage.label === 'Strong' && evaluation.canSubmit,
        observed: `${challenge.recommendation}, ${evaluation.coverage.label}, submit ${evaluation.canSubmit ? 'allowed' : 'blocked'}`,
      };
    },
  },
  {
    id: 2,
    title: 'Missing proof of delivery',
    expected: 'Flagged as missing, never invented, submit blocked',
    run: () => {
      const { ev, dispute, full } = fixtures();
      const { evaluation } = full(dispute('visa-13.1', 89), [ev('refund', 'none', 'ORD-VAL')]);
      const pod = evaluation.checks.find((c) => c.id === 'delivery-proof');
      return {
        passed: pod?.status === 'missing' && pod.evidence === null && !evaluation.canSubmit,
        observed: `proof of delivery ${pod?.status ?? 'absent'}, submit ${evaluation.canSubmit ? 'allowed' : 'blocked'}`,
      };
    },
  },
  {
    id: 3,
    title: 'Refund initiated but not completed',
    expected: 'Partial, and initiated is treated differently from completed',
    run: () => {
      const { ev, dispute, full } = fixtures();
      const base = [ev('product-description', 'matches-delivered', 'CONF-1'), ev('customer-message', 'no-complaint', 'SUP-2', { kind: 'inference' })];
      const initiated = full(dispute('visa-13.3', 60), [...base, ev('refund', 'initiated', 'REF-1')]);
      const completed = full(dispute('visa-13.3', 60), [...base, ev('refund', 'completed-before-dispute', 'REF-1')]);
      return {
        passed: initiated.evaluation.coverage.label === 'Partial' && initiated.challenge.recommendation !== completed.challenge.recommendation,
        observed: `initiated: ${initiated.evaluation.coverage.label}, ${initiated.challenge.recommendation}; completed: ${completed.challenge.recommendation}`,
      };
    },
  },
  {
    id: 4,
    title: 'Approved refund never processed because of an incident',
    expected: 'Accept, citing the refund',
    run: () => {
      const { ev, dispute, full } = fixtures();
      const { challenge } = full(dispute('visa-13.3', 249), [
        ev('product-description', 'matches-delivered', 'CONF-1'),
        ev('customer-message', 'acknowledged-receipt', 'SUP-3', { kind: 'inference' }),
        ev('refund', 'approved-not-completed', 'REF-231', { meta: { linkedIncident: 'INC-231', linkedDeploy: 'DEP-88' } }),
      ]);
      return { passed: challenge.recommendation === 'accept' && /REF-231/.test(challenge.why), observed: `${challenge.recommendation}: ${challenge.why}` };
    },
  },
  {
    id: 5,
    title: 'Customer message contradicts the merchant',
    expected: 'Challenge raises it and the fight is downgraded',
    run: () => {
      const { ev, dispute, full } = fixtures();
      const { evaluation, challenge } = full(dispute('visa-13.1', 89), [
        ev('delivery', 'delivered', 'ORD-VAL'),
        ev('refund', 'none', 'ORD-VAL'),
        ev('customer-message', 'denied-receipt', 'SUP-4', { kind: 'inference', meta: { quote: 'It never arrived' } }),
      ]);
      const raised = challenge.findings.some((f) => f.rule === 'customer-contradicts');
      return {
        passed: raised && evaluation.recommendation === 'fight' && challenge.recommendation === 'investigate',
        observed: `rubric ${evaluation.recommendation}, after challenge ${challenge.recommendation}${raised ? ', contradiction raised' : ''}`,
      };
    },
  },
  {
    id: 6,
    title: 'Duplicate charge',
    expected: 'Detected, accept',
    run: () => {
      const { ev, dispute, full } = fixtures();
      const { challenge } = full(dispute('visa-12.6.1', 49), [ev('order-pair', 'duplicate', 'ORD-VAL'), ev('incident', 'none', 'OPS')]);
      return { passed: challenge.recommendation === 'accept', observed: challenge.recommendation };
    },
  },
  {
    id: 7,
    title: 'Many disputes from one incident',
    expected: 'Clustered under the incident',
    run: () => {
      const { ev } = fixtures();
      const cases: DisputeCase[] = Array.from({ length: 5 }, (_, i) => ({
        issueKey: `DSP-${i + 1}`,
        customer: `cus_${i}`,
        amount: minor(4900),
        currency: 'USD',
        evidence: [ev('refund', 'approved-not-completed', `REF-${i}`, { meta: { linkedIncident: 'INC-231', linkedDeploy: 'DEP-88' } })],
      }));
      const [cluster] = clusterDisputes(cases);
      return {
        passed: cluster?.incidentKey === 'INC-231' && cluster.disputes.length === 5,
        observed: cluster ? `${cluster.disputes.length} disputes under ${cluster.incidentKey}` : 'no cluster',
      };
    },
  },
  {
    id: 8,
    title: 'Unrelated deploy around the same time',
    expected: 'No causal claim and no cluster',
    run: () => {
      const { ev, dispute, full } = fixtures();
      const unrelated = ev('incident', 'unrelated', 'INC-300', { meta: { windowStart: '2026-09-30T00:00:00Z', windowEnd: '2026-10-03T00:00:00Z' } });
      const { challenge } = full(dispute('visa-12.6.1', 49), [ev('order-pair', 'distinct', 'ORD-VAL'), unrelated]);
      const clusters = clusterDisputes([
        { issueKey: 'DSP-1', customer: 'a', amount: minor(100), currency: 'USD', evidence: [unrelated] },
        { issueKey: 'DSP-2', customer: 'b', amount: minor(100), currency: 'USD', evidence: [unrelated] },
      ]);
      const note = challenge.findings.find((f) => f.rule === 'incident-overlap-unlinked');
      return {
        passed: challenge.recommendation === 'fight' && note?.severity === 'note' && clusters.length === 0,
        observed: `${challenge.recommendation}, overlap ${note ? 'noted without a causal claim' : 'not noted'}, ${clusters.length} clusters`,
      };
    },
  },
  {
    id: 9,
    title: 'Policy changed after purchase',
    expected: 'The newer version is flagged; the version in force at purchase passes',
    run: () => {
      const { ev, dispute, full } = fixtures();
      const base = [ev('delivery', 'delivered', 'ORD-VAL'), ev('refund', 'none', 'ORD-VAL')];
      const v2 = ev('policy', 'accepted-at-checkout', 'CONF-12', { meta: { version: 'v2', effectiveFrom: '2026-10-15T00:00:00Z', effectiveTo: null } });
      const v1 = ev('policy', 'accepted-at-checkout', 'CONF-11', { meta: { version: 'v1', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-10-15T00:00:00Z' } });
      const withV2 = full(dispute('visa-13.1', 89), [...base, v2]).challenge.findings.some((f) => f.rule === 'policy-not-in-force');
      const withV1 = full(dispute('visa-13.1', 89), [...base, v1]).challenge.findings.some((f) => f.rule === 'policy-not-in-force');
      return { passed: withV2 && !withV1, observed: `v2 ${withV2 ? 'flagged' : 'not flagged'}, v1 ${withV1 ? 'flagged' : 'accepted'}` };
    },
  },
  {
    id: 10,
    title: 'Sparse context',
    expected: 'Says insufficient evidence',
    run: () => {
      const { dispute, full } = fixtures();
      const { evaluation, challenge } = full(dispute('visa-13.3', 35), []);
      return {
        passed: evaluation.coverage.label === 'Insufficient evidence' && challenge.recommendation === 'investigate',
        observed: `${evaluation.coverage.label}, ${challenge.recommendation}`,
      };
    },
  },
];

export function runValidationSuite(): ValidationReport {
  const results = VALIDATION_CASES.map((c) => {
    try {
      const { passed, observed } = c.run();
      return { id: c.id, title: c.title, expected: c.expected, observed, passed };
    } catch (error) {
      return { id: c.id, title: c.title, expected: c.expected, observed: `error: ${String(error)}`, passed: false };
    }
  });
  return { passed: results.filter((r) => r.passed).length, total: results.length, results };
}
