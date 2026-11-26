// Reason-code rubrics as data. Rule text is shown verbatim in the UI as "why is this required?",
// so it is written in plain English for an analyst, not a network rulebook.
//
// These are Visa rules (review B9). The Mastercard aliases only let a code be recognised; a dispute on a
// Mastercard, American Express or Discover card is shown as not supported yet rather than judged by Visa
// rules (see evaluate.ts). Response windows and thresholds vary by processor agreement, so they are
// configuration, not rubric data.

import type { Reason, ReasonKey, Requirement } from '../types';

/** A refund is owed or already promised and still outstanding: the customer is right. */
const REFUND_OWED = ['approved-not-completed'] as const;

const refundStatus = (rule: string): Requirement => ({
  id: 'refund-status',
  label: 'No refund is still owed to the customer',
  accepts: [{ type: 'refund', states: ['none', 'declined-per-policy', 'completed-before-dispute'] }],
  concedes: [{ type: 'refund', states: REFUND_OWED }],
  required: true,
  rule,
});

const returnPolicy = (label: string): Requirement => ({
  id: 'policy',
  label,
  accepts: [{ type: 'policy', states: ['accepted-at-checkout'] }],
  required: false,
  rule: 'Shows the terms the customer agreed to when they paid. Only the version in force on the purchase date counts.',
});

export const REASONS: Record<ReasonKey, Reason> = {
  'visa-13.1': {
    key: 'visa-13.1',
    label: 'Item not received',
    code: 'Visa 13.1',
    aliases: ['mc-4855'],
    depth: 'deep',
    requirements: [
      {
        id: 'delivery-proof',
        label: 'Proof of delivery to the customer’s address',
        accepts: [{ type: 'delivery', states: ['delivered'] }],
        required: true,
        rule: 'Carrier tracking that shows delivery to the shipping address the customer gave at checkout.',
      },
      {
        id: 'signed-pod',
        label: 'Signed proof of delivery',
        accepts: [{ type: 'delivery-signature', states: ['signed'] }],
        required: (ctx) => ctx.amount >= ctx.signatureThreshold,
        rule: 'For higher-value orders, issuers usually reject tracking alone and expect a signature at delivery.',
      },
      {
        id: 'customer-ack',
        label: 'Customer acknowledged receipt',
        accepts: [{ type: 'customer-message', states: ['acknowledged-receipt'] }],
        opposes: [{ type: 'customer-message', states: ['denied-receipt'] }],
        required: false,
        rule: 'A message from the customer confirming they received the order is strong supporting evidence.',
      },
      refundStatus('If the customer was promised a refund that never arrived, they are right to dispute and the case should be accepted.'),
      returnPolicy('Shipping and refund policy the customer agreed to'),
    ],
    creditDefense: true,
  },

  'visa-13.3': {
    key: 'visa-13.3',
    label: 'Not as described',
    code: 'Visa 13.3',
    aliases: ['mc-4853'],
    depth: 'deep',
    requirements: [
      {
        id: 'description',
        label: 'Product description matches what was delivered',
        accepts: [{ type: 'product-description', states: ['matches-delivered'] }],
        required: true,
        rule: 'Show that what the customer received matches what was advertised at the time of purchase.',
      },
      {
        id: 'no-prior-complaint',
        label: 'Customer did not raise the problem with us first',
        // Saying the parcel arrived proves receipt, not that it was as described, so it does not count here.
        accepts: [{ type: 'customer-message', states: ['no-complaint'] }],
        opposes: [{ type: 'customer-message', states: ['complained', 'requested-refund'] }],
        required: true,
        rule: 'Issuers expect a customer to try to resolve a quality problem with the merchant before disputing. A complaint we did not resolve weakens the case. If the customer wrote to us about this order, a person should read what they said.',
      },
      refundStatus('If a refund was approved but never paid, the customer is owed that money, and fighting risks refunding twice and paying the dispute fee.'),
      returnPolicy('Return policy the customer agreed to'),
    ],
    creditDefense: true,
  },

  'visa-12.6.1': {
    key: 'visa-12.6.1',
    label: 'Charged twice',
    code: 'Visa 12.6.1',
    aliases: ['mc-4834'],
    depth: 'deep',
    requirements: [
      {
        id: 'distinct-orders',
        label: 'Each charge maps to its own order, or the duplicate was refunded',
        accepts: [{ type: 'order-pair', states: ['distinct', 'duplicate-refunded', 'only-charge'] }],
        concedes: [{ type: 'order-pair', states: ['duplicate'] }],
        required: true,
        rule: 'A duplicate-charge dispute is defensible if there is no second charge, if the two charges are for different orders, or if the extra charge was already refunded. Two identical orders minutes apart need a person to check.',
      },
      {
        id: 'no-incident',
        label: 'No linked incident caused duplicate charges',
        accepts: [{ type: 'incident', states: ['none', 'unrelated', 'dropped-refund-repaired'] }],
        concedes: [{ type: 'incident', states: ['caused-duplicate-charge'] }],
        required: true,
        rule: 'If an incident or deploy is linked to duplicate charges for this customer, the customer is right and the dispute should be accepted.',
      },
    ],
  },

  'visa-10.4': {
    key: 'visa-10.4',
    label: 'Card-not-present fraud',
    code: 'Visa 10.4',
    aliases: ['mc-4837'],
    depth: 'deep-lite',
    requirements: [
      {
        id: 'cardholder-verified',
        label: 'Cardholder verified by 3-D Secure, or Compelling Evidence 3.0 history',
        accepts: [
          { type: '3ds', states: ['authenticated'] },
          { type: 'prior-orders', states: ['ce30-eligible'] },
        ],
        required: true,
        rule: 'A 3-D Secure authenticated payment shifts fraud liability to the issuer. Without it, Visa Compelling Evidence 3.0 needs two or more earlier transactions on the same card, 120 to 365 days before the dispute, never disputed or reported as fraud, each sharing at least two of IP address, device, account and shipping address with this order, one of them IP address or device.',
      },
      {
        id: 'avs-match',
        label: 'Billing address check matched',
        accepts: [{ type: 'avs', states: ['match'] }],
        required: false,
        rule: 'An address verification match supports that the person paying knew the cardholder’s billing address.',
      },
      {
        id: 'cvv-match',
        label: 'Card security code matched',
        accepts: [{ type: 'cvv', states: ['match'] }],
        required: false,
        rule: 'A security code match supports that the person paying had the physical card details.',
      },
    ],
  },

  'visa-13.2': {
    key: 'visa-13.2',
    label: 'Cancelled subscription',
    code: 'Visa 13.2',
    aliases: ['mc-4841'],
    depth: 'stub',
    requirements: [
      {
        id: 'not-cancelled',
        label: 'Customer had not cancelled before the charge',
        accepts: [{ type: 'cancellation', states: ['none-before-charge'] }],
        concedes: [{ type: 'cancellation', states: ['cancelled-before-charge'] }],
        opposes: [{ type: 'customer-message', states: ['cancelled'] }],
        required: true,
        rule: 'A recurring charge after the customer cancelled cannot be defended.',
      },
      returnPolicy('Cancellation terms the customer agreed to'),
    ],
  },

  'visa-13.6': {
    key: 'visa-13.6',
    label: 'Credit not processed',
    code: 'Visa 13.6',
    aliases: ['mc-4860'],
    depth: 'deep',
    requirements: [
      {
        id: 'credit-processed',
        label: 'The promised credit was processed, or none was due',
        // none and declined-per-policy: no credit was owed.
        accepts: [{ type: 'refund', states: ['completed-before-dispute', 'none', 'declined-per-policy'] }],
        concedes: [{ type: 'refund', states: REFUND_OWED }],
        required: true,
        rule: 'Show that the refund the customer was promised was paid before they disputed, or that no refund was owed under the policy they accepted. A refund that was approved and never paid means the customer is right.',
      },
      returnPolicy('Refund policy the customer accepted at checkout'),
    ],
    creditDefense: true,
  },
};

const normalise = (code: string): string => code.trim().toLowerCase().replace(/[\s_]+/g, '-');

/** Find a reason by key, network code ("Visa 13.1") or alias ("MC 4853"). */
export function findReason(code: string | null | undefined): Reason | null {
  if (!code) return null;
  const key = normalise(code);
  for (const reason of Object.values(REASONS)) {
    if (reason.key === key || normalise(reason.code) === key || reason.aliases.includes(key)) return reason;
  }
  return null;
}
