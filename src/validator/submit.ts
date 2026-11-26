// jira:workflowValidator on "Submit to network" (D-07).
// Passes only when the rubric says fight and every required exhibit is present. Fails closed.

import { evaluateIssue, UNTRUSTED_RECORD_MESSAGE } from '../lib/evaluate-issue';

interface ValidatorEvent {
  issue?: { key?: string; id?: string | number };
}

interface ValidatorResult {
  result: boolean;
  errorMessage?: string;
}

export async function validateSubmit(event: ValidatorEvent): Promise<ValidatorResult> {
  const issueKey = event.issue?.key;
  if (!issueKey) return { result: false, errorMessage: 'Exhibita could not identify this work item, so submission is blocked.' };

  try {
    // Only Exhibita's stored copy counts; the work item copy can be edited by anyone with edit rights (D-11).
    const loaded = await evaluateIssue(issueKey, event.issue?.id !== undefined ? String(event.issue.id) : undefined);
    if (!loaded.record) {
      return { result: false, errorMessage: `${UNTRUSTED_RECORD_MESSAGE[loaded.trust === 'unverified' ? 'unverified' : 'none']} Submission is blocked.` };
    }
    const { evaluation, verdict, challenge } = loaded;
    if (verdict.incomplete) {
      return { result: false, errorMessage: 'Exhibita has not finished reading every evidence source for this dispute, so submission is blocked. Use "Collect evidence again" in the Exhibita panel, then try again.' };
    }
    if (verdict.canSubmit) return { result: true };
    if (verdict.recommendation === 'accept') {
      return { result: false, errorMessage: `Exhibita recommends accepting this dispute: ${verdict.why}` };
    }
    if (!evaluation.canSubmit) {
      const missing = evaluation.blockers.length > 0 ? evaluation.blockers.join('; ') : evaluation.why;
      return { result: false, errorMessage: `Evidence incomplete (${evaluation.coverage.met} of ${evaluation.coverage.total} required). Add: ${missing}` };
    }
    // Every item is met, but the challenge found something that makes fighting unsafe.
    const problems = challenge.findings.filter((f) => f.severity !== 'note').map((f) => f.title);
    return { result: false, errorMessage: `Challenge found a problem to resolve before submitting: ${problems.join('; ') || verdict.why}` };
  } catch (error) {
    console.error('Submit validator failed closed', error);
    return { result: false, errorMessage: 'Exhibita could not check the evidence right now, so submission is blocked. Try again in a minute.' };
  }
}
