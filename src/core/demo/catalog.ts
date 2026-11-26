// Fixed, synthetic content for the demo world: invented names, generic products, an invented carrier,
// customer messages with the labels the lexicon gives them, and policy bodies. Nothing here names a
// real merchant, customer, brand or carrier (invariant 9).

import type { MessageLabel } from '../classify/lexicon';
import type { ProductRow } from '../sources/types';

export const CARRIER = 'Demo Parcel Co.';

export const FIRST_NAMES = [
  'Amara', 'Bastian', 'Chiara', 'Dev', 'Elif', 'Farah', 'Gideon', 'Hana', 'Ilan', 'Jonas',
  'Kavya', 'Lior', 'Mireille', 'Nadia', 'Oren', 'Priya', 'Quinn', 'Rafael', 'Saoirse', 'Tomas',
  'Uma', 'Vikram', 'Wren', 'Ximena', 'Yusuf', 'Zara', 'Anouk', 'Bram', 'Cosima', 'Darius',
] as const;

export const LAST_NAMES = [
  'Achterberg', 'Brannigan', 'Castellano', 'Delacroix', 'Eriksen', 'Fairweather', 'Galloway', 'Halvorsen',
  'Ibarra', 'Jankowski', 'Kowalczyk', 'Lindqvist', 'Marchetti', 'Nakashima', 'Okonkwo', 'Pellegrini',
  'Quintero', 'Rasmussen', 'Szabo', 'Thorne', 'Underhill', 'Vasquez', 'Whitlock', 'Yamada', 'Zielinski',
] as const;

export interface CatalogProduct {
  row: ProductRow;
  /** Price in cents. */
  price: number;
}

const physical = (sku: string, name: string, description: string, price: number): CatalogProduct => ({
  row: { sku, name, description, kind: 'physical' },
  price,
});

/** The hero's product. $249.00. */
export const HERO_PRODUCT = physical(
  'SKU-JACKET',
  'Waterproof trail jacket',
  'Three-layer waterproof shell with taped seams, a fleece-lined collar and two zip pockets.',
  24_900,
);

export const PRODUCTS: readonly CatalogProduct[] = [
  HERO_PRODUCT,
  physical('SKU-LAMP', 'Cordless desk lamp', 'Rechargeable LED desk lamp with three brightness levels.', 8_900),
  physical('SKU-POUR', 'Ceramic pour-over set', 'Hand-glazed ceramic dripper with a matching carafe.', 6_400),
  physical('SKU-BOTTLE', 'Insulated water bottle', 'Double-walled steel bottle that keeps drinks cold for 24 hours.', 3_200),
  physical('SKU-THROW', 'Wool throw blanket', 'Woven wool throw, 130 by 170 cm, in natural undyed grey.', 11_900),
  physical('SKU-GRINDER', 'Burr coffee grinder', 'Conical burr grinder with 40 grind settings.', 18_900),
  physical('SKU-HEADPHONES', 'Over-ear headphones', 'Wireless over-ear headphones with a 30-hour battery.', 22_900),
  physical('SKU-DESK', 'Standing desk converter', 'Height-adjustable desk riser with a keyboard tray.', 27_900),
  physical('SKU-NOTEBOOK', 'Leather-bound notebook', 'A5 notebook with 200 pages of dotted paper.', 4_500),
  physical('SKU-BLENDER', 'Countertop blender', '1200 W blender with a 1.5 litre glass jug.', 13_900),
  physical('SKU-BOOTS', 'Hiking boots', 'Leather hiking boots with a waterproof lining.', 16_900),
  {
    row: { sku: 'SKU-COFFEE-SUB', name: 'Monthly coffee subscription', description: 'One 500 g bag of freshly roasted coffee each month.', kind: 'subscription' },
    price: 2_400,
  },
  {
    row: { sku: 'SKU-SNACK-SUB', name: 'Monthly snack box', description: 'A box of twelve assorted snacks each month.', kind: 'subscription' },
    price: 3_900,
  },
];

export const PHYSICAL = PRODUCTS.filter((p) => p.row.kind === 'physical');
export const SUBSCRIPTIONS = PRODUCTS.filter((p) => p.row.kind === 'subscription');
/** Orders at or above $150 need a signed proof of delivery (the rubric's default threshold). */
export const HIGH_VALUE = PHYSICAL.filter((p) => p.price >= 15_000);
export const LOW_VALUE = PHYSICAL.filter((p) => p.price < 15_000);

export interface MessageTemplate {
  text: string;
  /** What the lexicon finds in this text, checked by test/core/demo.test.ts. */
  labels: readonly MessageLabel[];
}

const msg = (text: string, ...labels: MessageLabel[]): MessageTemplate => ({ text, labels });

/** Customer messages. The labels are what classifyMessage returns, not what a reader might expect. */
export const MESSAGES = {
  // The hero: looks like a happy customer, then asks for a refund that never arrives.
  heroAck: msg('Got it, thanks! The jacket arrived this morning.', 'acknowledged-receipt'),
  heroRefund: msg(
    'The jacket is not what I ordered, the lining is completely different from the photos. I would like to return it and get a refund.',
    'complained',
    'requested-refund',
  ),
  heroChase: msg(
    'My refund was approved weeks ago and it is still not on my statement. If it does not show up soon I will have to call my bank.',
    'mentioned-bank',
  ),
  // Customers whose approved refunds were dropped.
  chaseApproved: msg('Your team approved my refund, but the money is not on my card yet.'),
  chaseWhere: msg('I was told my refund was approved. Can you check where it is?'),
  chasePlease: msg('Refund please, it was approved two weeks ago and nothing has happened since.', 'requested-refund'),
  chaseAccount: msg('Hello, checking on the refund you approved for my order. It has not reached my account.'),
  watcherBank: msg('Still no sign of my refund. I will dispute the charge with my bank if this drags on.', 'mentioned-bank'),
  watcherChargeback: msg('Three weeks and no refund. Next step is a chargeback.', 'mentioned-bank'),
  // Other disputes.
  arrivedThanks: msg('Package arrived today, thank you.', 'acknowledged-receipt'),
  arrivedFine: msg("It wasn't easy to open, but it arrived fine. Not broken, just smaller than I expected.", 'acknowledged-receipt'),
  receivedOrder: msg('Received the order, thanks. Works well so far.', 'acknowledged-receipt'),
  neverArrived: msg(
    'Where is my order? Tracking says delivered but there is nothing at my door. I never received it.',
    'denied-receipt',
  ),
  wrongAddress: msg("The tracking shows it went to an old address of mine. I haven't got anything.", 'denied-receipt'),
  stoppedWorking: msg('The blender stopped working after two days. Very disappointed.', 'complained'),
  cancelledCharged: msg('I cancelled my subscription last month and you still charged me. I want my money back.', 'requested-refund'),
  twoCharges: msg('I can see two charges for the same order on my statement. Can you explain?'),
  billingAddress: msg('Hi, can you update the billing address on my account?'),
  giftWrap: msg('Do you offer gift wrapping for my next order?'),
} as const satisfies Record<string, MessageTemplate>;

export type MessageKey = keyof typeof MESSAGES;

const page = (title: string, ...paragraphs: string[]) =>
  `<h1>${title}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join('')}`;

export const POLICY_BODIES = {
  refundV1: page(
    'Refund &amp; Returns Policy (v1)',
    'You can return any unused item within 30 days of delivery for a full refund.',
    'Once we approve a refund, we pay it to the original card. It usually arrives within 5 to 10 business days.',
    'Items that arrive damaged or not as described can be returned at any time within 60 days.',
  ),
  refundV2: page(
    'Refund &amp; Returns Policy (v2)',
    'You can return any unused item within 14 days of delivery for a full refund. Opened items may carry a 10% restocking fee.',
    'Once we approve a refund, we pay it to the original card within 5 business days.',
    'Items that arrive damaged or not as described can be returned at any time within 30 days.',
  ),
  shipping: page(
    'Shipping Policy',
    `We ship with ${CARRIER} and send tracking for every order.`,
    'Orders of $150 or more need a signature on delivery.',
    'If tracking shows no movement for 7 days, contact us and we will open a trace.',
  ),
  cancellation: page(
    'Cancellation Policy',
    'You can cancel a subscription at any time from your account page.',
    'Cancelling stops all future charges straight away. We do not charge for the month after you cancel.',
  ),
} as const;
