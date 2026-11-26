// The single verdict every surface shows and the validator enforces (D-12): the rubric's result, then
// the challenge. The challenge can block a submission, never unblock one.

import type { ChallengeResult } from './challenge/challenge';
import type { Evaluation, Recommendation } from './types';

export interface Verdict {
  recommendation: Recommendation;
  why: string;
  /** Every required item met, and the final recommendation is still Fight. */
  canSubmit: boolean;
  /** True when the challenge changed the rubric's recommendation (for example Fight to Accept). */
  changed: boolean;
}

export function finalVerdict(evaluation: Evaluation, challenge: ChallengeResult): Verdict {
  return {
    recommendation: challenge.recommendation,
    why: challenge.why,
    canSubmit: evaluation.canSubmit && challenge.recommendation === 'fight',
    changed: challenge.changed,
  };
}
