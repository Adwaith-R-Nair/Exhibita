import { describe, expect, it } from 'vitest';
import {
  disputeWorkflowCreateBody,
  hasSubmitValidator,
  SUBMIT_TRANSITION,
  validatorExtensionKey,
} from '../../src/core/setup/workflow';

const ADMIN = 'ari:cloud:ecosystem::extension/0c0185eb-c3c6-4f56-a94d-39c45b26a884/0b237eec-c604-4ab1-9f4b-1c16a2e73d72/static/exhibita-admin';
const VALIDATOR = 'ari:cloud:ecosystem::extension/0c0185eb-c3c6-4f56-a94d-39c45b26a884/0b237eec-c604-4ab1-9f4b-1c16a2e73d72/static/exhibita-submit-validator';

describe('validatorExtensionKey', () => {
  it('swaps the module key of the calling module for the validator (matches what Jira stored in S8)', () => {
    expect(validatorExtensionKey(ADMIN, 'exhibita-submit-validator')).toBe(VALIDATOR);
  });
  it('refuses anything that is not an extension ARI', () => {
    expect(() => validatorExtensionKey('exhibita-admin', 'x')).toThrow();
  });
});

describe('disputeWorkflowCreateBody', () => {
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const body = disputeWorkflowCreateBody({ existingStatusIds: { New: '10010' }, validatorKey: VALIDATOR, uuid });
  const wf = body.workflows[0]!;

  it('puts the Exhibita validator on Submit to network and nowhere else', () => {
    const withValidator = wf.transitions.filter((t) => t.validators.length > 0);
    expect(withValidator.map((t) => t.name)).toEqual([SUBMIT_TRANSITION]);
    expect(withValidator[0]!.validators[0]).toEqual({ ruleKey: 'forge:expression-validator', parameters: { key: VALIDATOR, config: '' } });
  });

  it('reuses statuses that already exist and creates the rest', () => {
    expect(body.statuses.find((s) => s.name === 'New')).toMatchObject({ id: '10010' });
    expect(body.statuses.find((s) => s.name === 'Won')).not.toHaveProperty('id');
  });

  it('links every transition to statuses declared in the workflow', () => {
    const refs = new Set(wf.statuses.map((s) => s.statusReference));
    for (const t of wf.transitions) {
      expect(refs.has(t.toStatusReference)).toBe(true);
      for (const l of t.links as { fromStatusReference: string }[]) expect(refs.has(l.fromStatusReference)).toBe(true);
    }
  });

  it('lets a dispute be submitted from Collecting evidence or Ready to submit', () => {
    const submit = wf.transitions.find((t) => t.name === SUBMIT_TRANSITION)!;
    const name = (ref: string) => body.statuses.find((s) => s.statusReference === ref)!.name;
    expect((submit.links as { fromStatusReference: string }[]).map((l) => name(l.fromStatusReference))).toEqual(['Collecting evidence', 'Ready to submit']);
  });
});

describe('hasSubmitValidator', () => {
  it('finds our validator by key on the submit transition only', () => {
    const rule = { ruleKey: 'forge:expression-validator', parameters: { key: VALIDATOR } };
    expect(hasSubmitValidator([{ name: SUBMIT_TRANSITION, validators: [rule] }], VALIDATOR)).toBe(true);
    expect(hasSubmitValidator([{ name: 'Accept dispute', validators: [rule] }], VALIDATOR)).toBe(false);
    expect(hasSubmitValidator([{ name: SUBMIT_TRANSITION, validators: [] }], VALIDATOR)).toBe(false);
  });
});
