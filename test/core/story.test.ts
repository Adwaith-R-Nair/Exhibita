// The demo story (docs/SPEC.md §3), end to end through the real engine: generate the world, observe it
// the way the platform fetchers will, collect evidence, evaluate, challenge and cluster.

import { describe, expect, it } from 'vitest';
import { challengeDispute } from '../../src/core/challenge/challenge';
import { blastRadius, clusterDisputes, type AffectedOrder, type DisputeCase } from '../../src/core/cluster/cluster';
import { collectEvidence } from '../../src/core/collect';
import { DEMO_REFS, STORY, demoKeys, generateWorld, observeWorld } from '../../src/core/demo';
import { evaluateDispute } from '../../src/core/rubric/evaluate';
import { minor } from '../../src/core/types';

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
      return { orderId: order.id, customer: order.customerId, amount: refund.amount };
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

  it('flips the hero to accept, citing the refund', () => {
    const hero = cases.find((c) => c.demo.hero)!;
    expect(hero.dispute.amount).toBe(24_900);
    expect(hero.challenge.recommendation).toBe('accept');
    expect(hero.challenge.why).toMatch(/refund/i);
    expect(hero.challenge.why).toMatch(/REF-\d+/);
    // It looks defensible on its face: delivered, as described, and the customer said they got it.
    const states = hero.evidence.map((e) => `${e.type}:${e.state}`);
    expect(states).toEqual(expect.arrayContaining(['delivery:delivered', 'product-description:matches-delivered', 'customer-message:acknowledged-receipt']));
    expect(states).toContain('refund:approved-not-completed');
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
    expect(radius.disputesSoFar).toBe(STORY.clusterSize);
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
      totals.add(`${clusters[0]!.totalAmount}/${radius.proactiveRefundTotal}`);
      expect(cases).toHaveLength(60);
      expect(clusters.map((c) => c.disputes.length)).toEqual([STORY.clusterSize]);
      expect(blastRadius(clusters[0]!, affected, { disputeFee: minor(1_500), analystMinutesPerDispute: 25 }).customersNotYetDisputed).toBe(
        STORY.notYetDisputed,
      );
      expect(cases.filter((c) => c.challenge.recommendation !== c.demo.expected).map((c) => c.demo.scenario)).toEqual([]);
    }
    expect(totals.size).toBe(1);
  });
});
