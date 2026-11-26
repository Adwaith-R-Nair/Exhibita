// The dispute record stored on each Jira work item (D-04). Every surface reads this one shape.

import type { Dispute, EvidenceItem } from './types';

export const RECORD_PROPERTY_KEY = 'exhibita';
export const RECORD_SCHEMA_VERSION = 1;

export interface DisputeRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  dispute: Dispute;
  evidence: EvidenceItem[];
  /** The original webhook payload, unchanged, for audit. */
  raw: unknown;
  /** When evidence was last collected (ISO 8601). */
  collectedAt: string | null;
}

/** Narrow an unknown issue-property value to a DisputeRecord, or null if it isn't one. */
export function asDisputeRecord(value: unknown): DisputeRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<DisputeRecord>;
  if (v.schemaVersion !== RECORD_SCHEMA_VERSION) return null;
  if (typeof v.dispute !== 'object' || v.dispute === null) return null;
  if (!Array.isArray(v.evidence)) return null;
  return v as DisputeRecord;
}
