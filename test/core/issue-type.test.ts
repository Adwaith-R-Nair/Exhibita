import { describe, expect, it } from 'vitest';
import { chooseWorkType, type WorkTypeOption } from '../../src/core/intake/issue-type';

const t = (name: string, hierarchyLevel = 0, subtask = false): WorkTypeOption => ({ id: name, name, subtask, hierarchyLevel });

describe('chooseWorkType', () => {
  it('never picks an epic, even when the site lists it first', () => {
    expect(chooseWorkType([t('Epic', 1), t('Incident'), t('Task')])?.name).toBe('Task');
  });

  it('prefers a type called Dispute over everything else', () => {
    expect(chooseWorkType([t('Task'), t('Service request'), t('DISPUTE')])?.name).toBe('DISPUTE');
  });

  it('prefers Service request over Task', () => {
    expect(chooseWorkType([t('Task'), t('Service request')])?.name).toBe('Service request');
  });

  it('never picks a subtask', () => {
    expect(chooseWorkType([t('Sub-task', -1, true), t('Change')])?.name).toBe('Change');
  });

  it('falls back to the first standard type, or null when there is none', () => {
    expect(chooseWorkType([t('Epic', 1), t('Change'), t('Problem')])?.name).toBe('Change');
    expect(chooseWorkType([t('Epic', 1), t('Sub-task', -1, true)])).toBeNull();
  });
});
