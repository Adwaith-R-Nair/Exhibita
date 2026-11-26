// Plain-English phrasing for evidence states, used in one-line explanations.

const PHRASES: Record<string, string> = {
  'approved-not-completed': 'approved but never completed',
  initiated: 'initiated but not yet completed',
  'completed-before-dispute': 'completed before the dispute',
  'declined-per-policy': 'declined under the refund policy',
  none: 'none',
  duplicate: 'a true duplicate of another charge',
  'duplicate-refunded': 'a duplicate that was already refunded',
  distinct: 'for a separate order',
  'caused-duplicate-charge': 'linked as the cause of duplicate charges',
  unrelated: 'unrelated',
  delivered: 'delivered',
  'delivered-address-mismatch': 'delivered to a different address than the customer gave',
  'in-transit': 'still in transit',
  'returned-to-sender': 'returned to sender',
  lost: 'lost by the carrier',
  signed: 'signed for',
  'signature-name-mismatch': 'signed by someone other than the customer',
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
  match: 'matched',
  mismatch: 'did not match',
};

export function describeState(state: string): string {
  return PHRASES[state] ?? state.replaceAll('-', ' ');
}
