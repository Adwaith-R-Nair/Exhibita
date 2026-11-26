// The demo story (docs/SPEC.md §3), end to end through the real engine: generate the world, observe it
// the way the platform fetchers will, collect evidence, evaluate, challenge and cluster.

import { describe, expect, it } from 'vitest';
import { challengeDispute } from '../../src/core/challenge/challenge';
import { blastRadius, clusterDisputes, type AffectedOrder, type DisputeCase } from '../../src/core/cluster/cluster';
import { collectEvidence } from '../../src/core/collect';
import { DEMO_REFS, STORY, demoKeys, generateWorld, observeWorld } from '../../src/core/demo';
import { evaluateDispute } from '../../src/core/rubric/evaluate';
import { COLLECT_SOURCES, type CollectSource } from '../../src/core/sources/types';
import { minor } from '../../src/core/types';
import { finalVerdict } from '../../src/core/verdict';

const NOW = '2026-11-26T09:00:00.000Z';

function runStory(seed: number) {
  const world = generateWorld({ seed, now: NOW });
  const keys = demoKeys(world);
  const cases = observeWorld(world, keys).map((o, i) => {
    const evidence = collectEvidence(o.input);
    const evaluation = evaluateDispute(o.dispute, evidence);
    const challenge = challengeDispute(o.dispute, evidence, evaluation);
    return { ...o, issueKey: `DSP-${i + 1}`, evidence, evaluation, challenge };
  });
  const clusters = clusterDisputes(
    cases.map<DisputeCase>((c) => ({
      issueKey: c.issueKey,
      orderId: c.dispute.orderId,
      customer: c.dispute.customer,
      amount: c.dispute.amount,
      currency: c.dispute.currency,
      evidence: c.evidence,
    })),
  );
  const affected: AffectedOrder[] = world.impacts
    .filter((i) => i.incidentRef === DEMO_REFS.refundIncident && i.refundId)
    .map((i) => {
      const refund = world.refunds.find((r) => r.id === i.refundId)!;
      const order = world.orders.find((o) => o.id === refund.orderId)!;
      return { orderId: order.id, customer: order.customerId, amount: refund.amount, currency: refund.currency };
    });
  return { world, keys, cases, clusters, affected };
}

describe.each([1, 42, 20261126])('the demo story, seed %i', (seed) => {
  const { keys, cases, clusters, affected } = runStory(seed);

  it('recommends what each scenario expects, after rubric and challenge', () => {
    const wrong = cases
      .filter((c) => c.challenge.recommendation !== c.demo.expected)
      .map((c) => `${c.demo.scenario}: expected ${c.demo.expected}, got ${c.challenge.recommendation} (${c.challenge.why})`);
    expect(wrong).toEqual([]);
  });

  it('flips the hero from a checklist Fight to Accept, citing the refund, the charge, the incident and the deploy', () => {
    const hero = cases.find((c) => c.demo.hero)!;
    expect(hero.dispute).toMatchObject({ amount: 24_900, reasonCode: 'visa-13.6', network: 'visa', networkReasonCode: '13.6' });
    // The refund service says the credit was sent before the dispute, so the checklist alone says Fight.
    expect(hero.evaluation).toMatchObject({ recommendation: 'fight', coverage: { label: 'Strong' }, canSubmit: true });
    const states = hero.evidence.map((e) => `${e.type}:${e.state}`);
    expect(states).toEqual(expect.arrayContaining(['refund:completed-before-dispute', 'processor-refund:not-settled', 'incident:caused-dropped-refund']));
    // The processor never received it.
    const verdict = finalVerdict(hero.evaluation, hero.challenge);
    expect(verdict).toMatchObject({ recommendation: 'accept', changed: true, canSubmit: false });
    const refundId = hero.evidence.find((e) => e.type === 'refund')!.meta!.refundId!;
    expect(verdict.why).toMatch(new RegExp(`marked ${refundId} as sent, but the processor shows no refund on the charge ${hero.dispute.chargeId}`));
    expect(verdict.why).toContain(keys.keyOf[DEMO_REFS.refundIncident]!);
    expect(verdict.why).toContain(keys.keyOf[DEMO_REFS.refundDeploy]!);
    expect(verdict.why).toMatch(/Refund worker marked refunds as sent without sending them/);
  });

  it('shows the hero flip source by source: Fight once refunds are read, Accept once settlements are', () => {
    const hero = cases.find((c) => c.demo.hero)!;
    const at = (read: number) => {
      const pending = COLLECT_SOURCES.slice(read) as CollectSource[];
      const evidence = collectEvidence({ ...hero.input, pending });
      const evaluation = evaluateDispute(hero.dispute, evidence);
      return finalVerdict(evaluation, challengeDispute(hero.dispute, evidence, evaluation)).recommendation;
    };
    const refundsRead = COLLECT_SOURCES.indexOf('refunds') + 1;
    expect(at(refundsRead)).toBe('fight');
    expect(at(refundsRead + 1)).toBe('accept');
    expect(at(COLLECT_SOURCES.length)).toBe('accept');
  });

  it('clusters exactly 38 disputes under the refund incident and its deploy', () => {
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      incidentKey: keys.keyOf[DEMO_REFS.refundIncident],
      deployKey: keys.keyOf[DEMO_REFS.refundDeploy],
    });
    expect(clusters[0]!.disputes).toHaveLength(STORY.clusterSize);
    expect(clusters[0]!.disputes.map((d) => d.issueKey)).toContain(cases.find((c) => c.demo.hero)!.issueKey);
  });

  it('finds 212 affected customers who have not disputed yet', () => {
    const radius = blastRadius(clusters[0]!, affected, { disputeFee: minor(1_500), analystMinutesPerDispute: 25 });
    expect(radius.customersNotYetDisputed).toBe(STORY.notYetDisputed);
    expect(radius.notYetDisputed).toHaveLength(STORY.notYetDisputed);
    expect(radius.disputesSoFar).toBe(STORY.clusterSize);
  });

  it('mixes credit-not-processed and not-as-described disputes in the cluster', () => {
    const inCluster = new Set(clusters[0]!.disputes.map((d) => d.issueKey));
    const reasons = new Set(cases.filter((c) => inCluster.has(c.issueKey)).map((c) => c.dispute.reasonCode));
    expect(reasons).toEqual(new Set(['visa-13.6', 'visa-13.3']));
  });

  it('answers a credit issued before the dispute, and shows a Mastercard dispute as not supported', () => {
    const lost = cases.find((c) => /refunded in full before the dispute/.test(c.demo.scenario))!;
    expect(lost.evaluation.why).toMatch(/^Credit issued before the dispute/);
    const mc = cases.find((c) => c.dispute.network === 'mastercard')!;
    expect(mc.evaluation).toMatchObject({ supported: false, recommendation: 'investigate' });
    expect(mc.evaluation.why).toBe('Mastercard disputes are not supported yet; review by hand.');
  });

  it('has one qualified Compelling Evidence 3.0 case and one candidate that fails only on the card', () => {
    const prior = (c: (typeof cases)[number]) => c.evidence.find((e) => e.type === 'prior-orders');
    const states = cases.map((c) => prior(c)?.state).filter(Boolean);
    expect(states.filter((s) => s === 'ce30-eligible')).toHaveLength(1);
    const candidate = cases.find((c) => prior(c)?.state === 'ce30-candidate')!;
    expect(prior(candidate)!.meta!.criteria!.filter((x) => !x.passed).map((x) => x.id)).toEqual(['same-card']);
  });

  it('makes no causal claim from an overlapping incident, and still fights', () => {
    const overlapping = cases.filter((c) => c.challenge.findings.some((f) => f.rule === 'incident-overlap-unlinked'));
    expect(overlapping.some((c) => c.challenge.recommendation === 'fight')).toBe(true);
    const storefront = keys.keyOf[DEMO_REFS.storefrontIncident];
    for (const c of cases) {
      const caused = c.evidence.filter((e) => e.type === 'incident' && e.state.startsWith('caused-'));
      expect(caused.map((e) => e.source.key)).not.toContain(storefront);
    }
  });

  it('only notes an overlapping incident where the scenario puts the purchase inside one', () => {
    const noted = cases.filter((c) => c.challenge.findings.some((f) => f.rule === 'incident-overlap-unlinked'));
    expect(noted.map((c) => c.demo.scenario).sort()).toEqual([
      'Charged twice: two separate orders, bought during an unrelated incident',
      'Item not received: bought during an unrelated incident, no causal claim',
    ]);
  });

  it('flags the policy version that was not in force at purchase, and only that one', () => {
    const flagged = cases.filter((c) => c.challenge.findings.some((f) => f.rule === 'policy-not-in-force'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.challenge.recommendation).toBe('investigate');
  });

  it('blocks submission unless the rubric says fight, and names what is missing', () => {
    for (const c of cases) if (c.evaluation.recommendation !== 'fight') expect(c.evaluation.canSubmit).toBe(false);
    const missingPod = cases.find((c) => /missing proof of delivery/i.test(c.demo.scenario))!;
    expect(missingPod.evaluation.canSubmit).toBe(false);
    expect(missingPod.evaluation.blockers).toContain('Proof of delivery to the customer’s address');
  });
});

describe('the demo story across seeds', () => {
  it('keeps the story numbers, including the dollar totals, for any seed', () => {
    const totals = new Set<string>();
    for (const seed of [3, 99, 123456]) {
      const { cases, clusters, affected } = runStory(seed);
      const radius = blastRadius(clusters[0]!, affected, { disputeFee: minor(1_500), analystMinutesPerDispute: 25 });
      totals.add(JSON.stringify([clusters[0]!.totals, radius.proactiveRefundTotals]));
      expect(cases).toHaveLength(STORY.disputes);
      expect(clusters.map((c) => c.disputes.length)).toEqual([STORY.clusterSize]);
      expect(blastRadius(clusters[0]!, affected, { disputeFee: minor(1_500), analystMinutesPerDispute: 25 }).customersNotYetDisputed).toBe(
        STORY.notYetDisputed,
      );
      expect(cases.filter((c) => c.challenge.recommendation !== c.demo.expected).map((c) => c.demo.scenario)).toEqual([]);
    }
    expect(totals.size).toBe(1);
  });
});
