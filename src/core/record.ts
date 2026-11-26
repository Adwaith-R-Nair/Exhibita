// The dispute record (D-04, D-11). Exhibita keeps the authoritative copy in app storage, which only
// the app can write, and mirrors it to the work item's "exhibita" property for JQL and display.
// Anyone who can edit a work item can rewrite its properties, so the mirror is never trusted alone.

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

/** JSON with object keys sorted, so two records compare equal whatever order their keys were written in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * How far a record can be trusted:
 * - verified: Exhibita's stored copy, and the work item copy matches it.
 * - copy-changed: Exhibita's stored copy is used, but the work item copy was edited or removed outside Exhibita.
 * - unverified: only a work item copy exists; Exhibita did not write it, so it is not used.
 * - none: no record at all.
 */
export type RecordTrust = 'verified' | 'copy-changed' | 'unverified' | 'none';

export type ReconciledRecord =
  | { trust: 'verified' | 'copy-changed'; record: DisputeRecord }
  | { trust: 'unverified' | 'none'; record: null };

/** Decide which copy of a record to use. Only the stored copy is ever returned. */
export function reconcileRecord(stored: DisputeRecord | null, copy: DisputeRecord | null): ReconciledRecord {
  if (stored) {
    const same = copy !== null && canonicalJson(copy) === canonicalJson(stored);
    return { trust: same ? 'verified' : 'copy-changed', record: stored };
  }
  return copy ? { trust: 'unverified', record: null } : { trust: 'none', record: null };
}

/** Why Exhibita won't use a record, in plain English. Shared by the panel, validator and agent actions. */
export const UNTRUSTED_RECORD_MESSAGE: Record<'unverified' | 'none', string> = {
  unverified:
    "This work item's dispute record wasn't written by Exhibita, so its evidence can't be trusted. Resend the dispute webhook to restore it.",
  none: 'This work item has no Exhibita dispute record.',
};

/** Shown when the work item's copy of the record no longer matches Exhibita's stored copy. */
export const COPY_CHANGED_MESSAGE =
  "The copy of this dispute's record on the work item was changed outside Exhibita. Exhibita is using its own stored copy, and submission is judged on that.";
