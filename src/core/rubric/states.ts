// Plain-English phrasing for evidence states and kinds, used in one-line explanations and the UI.

import type { EvidenceKind } from '../types';

/**
 * What the UI calls each kind of evidence (review B13). A system record shows what a system says, which
 * is not the same as proving a fact, so it is labelled "Record". Classified text is an "Inference".
 */
export const KIND_LABEL: Record<EvidenceKind, string> = { fact: 'Record', inference: 'Inference' };

const PHRASES: Record<string, string> = {
  'voided-settled-by-dispute': 'cancelled because the accepted chargeback settles it',
  'approved-not-completed': 'approved but never completed',
  'partial-approved-not-completed': 'approved for part of the amount but never completed',
  'completed-date-unknown': 'completed, date unknown',
  settled: 'settled at the processor',
  'not-settled': 'marked as sent, but the processor shows no refund',
  'only-charge': 'the only charge on record',
  'possible-duplicate': 'an identical order placed minutes apart, possibly a duplicate',
  'dropped-refund-repaired': 'linked to a dropped refund that has since been paid',
  'ce30-candidate': 'a Compelling Evidence 3.0 candidate that does not meet every criterion',
  'refund-not-received': 'said the refund has not arrived',
  'acknowledged-refund': 'acknowledged the refund',
  cancelled: 'said they cancelled',
  initiated: 'initiated but not yet completed',
  'completed-before-dispute': 'completed before the dispute',
  'declined-per-policy': 'declined under the refund policy',
  'completed-after-dispute': 'completed after the dispute arrived',
  requested: 'requested and not yet decided',
  none: 'none',
  duplicate: 'a true duplicate of another charge',
  'duplicate-refunded': 'a duplicate that was already refunded',
  distinct: 'for a separate order',
  'caused-duplicate-charge': 'linked as the cause of duplicate charges',
  'caused-dropped-refund': 'linked as the cause of a dropped refund',
  'caused-charge-problem': 'linked as the cause of a problem with this charge',
  unrelated: 'unrelated',
  delivered: 'delivered',
  'delivered-address-mismatch': 'delivered to a different address than the customer gave',
  'delivered-address-unverified': 'delivered, but the address was not checked',
  'in-transit': 'still in transit',
  'returned-to-sender': 'returned to sender',
  lost: 'lost by the carrier',
  signed: 'signed for',
  'signature-name-mismatch': 'signed by someone other than the customer',
  'signed-name-unverified': 'signed for, but the name was not checked',
  'matches-delivered': 'matches what was delivered',
  'differs-from-delivered': 'does not match what was delivered',
  'acknowledged-receipt': 'acknowledged receipt',
  'no-complaint': 'no complaint on record',
  complained: 'complained',
  'requested-refund': 'asked for a refund',
  'mentioned-bank': 'mentioned their bank',
  'denied-receipt': 'said it never arrived',
  'cancelled-before-charge': 'cancelled before the charge',
  'none-before-charge': 'no cancellation before the charge',
  authenticated: 'authenticated',
  'not-attempted': 'not attempted',
  'ce30-eligible': 'eligible for Compelling Evidence 3.0',
  'not-eligible': 'not eligible for Compelling Evidence 3.0',
  'accepted-at-checkout': 'accepted at checkout',
  attempted: 'attempted',
  failed: 'failed',
  unavailable: 'unavailable',
  match: 'matched',
  mismatch: 'did not match',
};

export function describeState(state: string): string {
  return PHRASES[state] ?? state.replaceAll('-', ' ');
}
