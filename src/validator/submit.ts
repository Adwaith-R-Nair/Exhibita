// jira:workflowValidator on "Submit to network" (D-07).
// Passes only when the rubric says fight and every required exhibit is present. Fails closed.

import { evaluateIssue } from '../lib/evaluate-issue';

interface ValidatorEvent {
  issue?: { key?: string };
}

interface ValidatorResult {
  result: boolean;
  errorMessage?: string;
}

export async function validateSubmit(event: ValidatorEvent): Promise<ValidatorResult> {
  const issueKey = event.issue?.key;
  if (!issueKey) return { result: false, errorMessage: 'Exhibita could not identify this work item, so submission is blocked.' };

  try {
    const loaded = await evaluateIssue(issueKey);
    if (!loaded) {
      return { result: false, errorMessage: 'This work item has no Exhibita dispute record, so there is no evidence to submit.' };
    }
    const { evaluation } = loaded;
    if (evaluation.canSubmit) return { result: true };
    if (evaluation.recommendation === 'accept') {
      return { result: false, errorMessage: `Exhibita recommends accepting this dispute: ${evaluation.why}` };
    }
    const missing = evaluation.blockers.length > 0 ? evaluation.blockers.join('; ') : evaluation.why;
    return { result: false, errorMessage: `Evidence incomplete (${evaluation.coverage.met} of ${evaluation.coverage.total} required). Add: ${missing}` };
  } catch (error) {
    console.error('Submit validator failed closed', error);
    return { result: false, errorMessage: 'Exhibita could not check the evidence right now, so submission is blocked. Try again in a minute.' };
  }
}
