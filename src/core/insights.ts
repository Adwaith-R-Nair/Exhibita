// "Why are we losing?" from the merchant's past outcomes. Counts only, from closed disputes: never a
// rate presented as a chance of winning, and never a prediction (D-08).

import { findReason } from './rubric/reasons';
import type { OutcomeRow } from './sources/types';
import type { ReasonKey } from './types';

export interface LossInsight {
  reasonCode: ReasonKey;
  lossReason: string;
  /** Lost disputes with this reason code and this loss reason. */
  count: number;
  /** All lost disputes with this reason code. */
  lostForReason: number;
  /** Money lost on them, in minor units of the first currency seen (demo data is single-currency). */
  amount: number;
  sentence: string;
}

export function whyWeLose(outcomes: readonly OutcomeRow[], limit = 3): LossInsight[] {
  const lost = outcomes.filter((o) => o.result === 'lost' && o.lossReason);
  const perReason = new Map<string, number>();
  for (const o of lost) perReason.set(o.reasonCode, (perReason.get(o.reasonCode) ?? 0) + 1);
  const groups = new Map<string, { reasonCode: ReasonKey; lossReason: string; count: number; amount: number }>();
  for (const o of lost) {
    const key = `${o.reasonCode}\u0000${o.lossReason}`;
    const g = groups.get(key) ?? { reasonCode: o.reasonCode, lossReason: o.lossReason!, count: 0, amount: 0 };
    g.count += 1;
    g.amount += o.amount;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.amount - a.amount || a.lossReason.localeCompare(b.lossReason))
    .slice(0, limit)
    .map((g) => {
      const lostForReason = perReason.get(g.reasonCode) ?? g.count;
      const label = findReason(g.reasonCode)?.label ?? g.reasonCode;
      return { ...g, lostForReason, sentence: `${g.count} of ${lostForReason} lost ${label} disputes: ${g.lossReason}.` };
    });
}
