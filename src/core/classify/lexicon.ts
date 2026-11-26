// Customer-message classifier: a phrase lexicon with negation handling (D-02).
// No model, no network call. Every label it produces is an Inference, never a Record, and carries
// the exact phrase it matched so the UI can quote it.
//
// Labels are independent facets of a message, not exclusive states: "Got it, but it arrived broken"
// is both an acknowledgement and a complaint (review B3).
//
// Rules, in the order they apply to each matched phrase:
// 1. Negation: a negator up to three words before the phrase, in the same clause, flips it
//    ("never arrived"). "yet" does not end a clause ("has not yet arrived").
// 2. Topic: a receipt word next to "refund" or "money" is about the refund, not the goods
//    ("my refund hasn't arrived" is refund-not-received).
// 3. Partial delivery: "half of my order arrived" is a complaint, not an acknowledgement.
// 4. Questions assert nothing about receipt or refunds ("Has it arrived yet?"), except phrases that
//    only make sense when it has not ("Where is my order?").

export type MessageLabel =
  | 'acknowledged-receipt'
  | 'denied-receipt'
  | 'complained'
  | 'requested-refund'
  | 'acknowledged-refund'
  | 'refund-not-received'
  | 'cancelled'
  | 'mentioned-bank';

export interface LabelMatch {
  label: MessageLabel;
  /** The matched text, as written by the customer. */
  phrase: string;
  /** Character offsets into the original message. */
  start: number;
  end: number;
  negated: boolean;
}

interface Entry {
  phrase: string;
  /** Label when the phrase is not negated. Null: the phrase only means something when negated. */
  label: MessageLabel | null;
  /** Label when the phrase is negated ("never arrived"). Null: negation cancels it. */
  negated: MessageLabel | null;
  /** Words that, straight after the phrase, mean it is about something else ("got it working"). */
  notBefore?: readonly string[];
  /** Still asserted inside a question ("Where is my order?"). */
  inQuestion?: boolean;
  /** A receipt verb that can be about the goods or the refund, depending on the words around it. */
  receiptVerb?: boolean;
}

/** After "got it" or "get it", these mean the customer is talking about something other than a parcel. */
const NOT_A_PARCEL = ['working', 'work', 'wrong', 'right', 'fixed', 'sorted', 'done', 'running', 'to', 'figured', 'installed', 'set'];

const receipt = (phrase: string, notBefore?: readonly string[]): Entry => ({
  phrase,
  label: 'acknowledged-receipt',
  negated: 'denied-receipt',
  receiptVerb: true,
  ...(notBefore ? { notBefore } : {}),
});
const receiptIfNegated = (phrase: string, notBefore?: readonly string[]): Entry => ({
  phrase,
  label: null,
  negated: 'denied-receipt',
  receiptVerb: true,
  ...(notBefore ? { notBefore } : {}),
});
const denial = (phrase: string, inQuestion = false): Entry => ({ phrase, label: 'denied-receipt', negated: null, ...(inQuestion ? { inQuestion } : {}) });
const complaint = (phrase: string): Entry => ({ phrase, label: 'complained', negated: null });
const complaintIfNegated = (phrase: string): Entry => ({ phrase, label: null, negated: 'complained' });
const refundRequest = (phrase: string): Entry => ({ phrase, label: 'requested-refund', negated: null });
const refundThanks = (phrase: string): Entry => ({ phrase, label: 'acknowledged-refund', negated: 'refund-not-received' });
const refundMissing = (phrase: string, inQuestion = false): Entry => ({
  phrase,
  label: 'refund-not-received',
  negated: null,
  ...(inQuestion ? { inQuestion } : {}),
});
const cancellation = (phrase: string): Entry => ({ phrase, label: 'cancelled', negated: null });
/** A bank mention signals dispute risk whether or not it is negated ("I don't want to call my bank"). */
const bank = (phrase: string): Entry => ({ phrase, label: 'mentioned-bank', negated: 'mentioned-bank' });

const GOODS = ['package', 'parcel', 'order', 'item', 'delivery', 'box'];

const LEXICON: readonly Entry[] = [
  ...['got it'].map((p) => receipt(p, NOT_A_PARCEL)),
  ...['got the package', 'got my order', 'got my package', 'got the item', 'got the parcel', 'received it',
    'received my order', 'received the order', 'received the package', 'received my package', 'received the parcel',
    'received the item', 'arrived', 'came today', 'picked it up', 'have it now', 'showed up'].map((p) => receipt(p)),
  ...['get it'].map((p) => receiptIfNegated(p, NOT_A_PARCEL)),
  ...['received', 'receive', 'have it', 'got anything', 'received anything', 'get anything', 'get the package',
    'get my order', 'get my package', 'get the item', 'get the parcel', 'delivered', 'arrive', 'came', 'come',
    'gotten', 'show up'].map((p) => receiptIfNegated(p)),
  denial('where is my order', true),
  denial('where is my package', true),
  denial('where is my parcel', true),
  denial('still waiting'),
  denial('lost in the mail'),
  denial('nothing at my door'),
  ...GOODS.flatMap((g) => [`${g} is missing`, `${g} went missing`, `missing ${g}`]).map((p) => denial(p)),
  ...['broken', 'cracked', 'damaged', 'defective', 'faulty', 'not as described', 'not what i ordered', 'wrong item',
    'wrong size', 'poor quality', 'disappointed', 'unhappy', 'not happy', 'terrible', 'misleading', 'does not work',
    'not working', 'stopped working', 'fake', 'scam', 'ripped off', 'complaint', 'does not match', 'did not match',
    'nothing like', 'different from', 'arrived empty', 'box was empty', 'empty box', 'missing'].map(complaint),
  ...['get it to work', 'get it working'].map(complaintIfNegated),
  ...['want a refund', 'want my refund', 'get a refund', 'need a refund', 'request a refund', 'requesting a refund',
    'refund please', 'refund me', 'please refund', 'issue a refund', 'give me a refund', 'like a refund',
    'demand a refund', 'money back', 'return it', 'send it back', 'want to return'].map(refundRequest),
  ...['thanks for the refund', 'thank you for the refund', 'refund came through', 'got the refund',
    'got my refund', 'received the refund', 'received my refund', 'refund arrived'].map(refundThanks),
  refundMissing('where is my refund', true),
  refundMissing('no sign of my refund'),
  refundMissing('no sign of the refund'),
  ...['cancelled', 'canceled', 'cancel my subscription', 'cancel my order', 'want to cancel', 'please cancel',
    'unsubscribed'].map(cancellation),
  ...['bank', 'chargeback', 'charge back', 'dispute', 'disputing', 'disputed', 'card company',
    'unauthorized', 'unauthorised', 'fraud', 'fraudulent', 'report you', 'file a claim'].map(bank),
];

const NEGATORS = new Set(['not', 'no', 'never', 'without', 'nothing', 'none', 'nor', 'neither']);
const PUNCTUATION = new Set(['.', ',', '!', '?', ';', ':']);
const CLAUSE_BREAKS = new Set(['but', 'however', 'although', 'though', 'because', 'since', ...PUNCTUATION]);
const SENTENCE_ENDS = new Set(['.', '!', '?']);
const NEGATION_WINDOW = 3;
/** How far a refund word may sit from a receipt verb and still make it about the refund. */
const TOPIC_BACK = 5;
const TOPIC_AHEAD = 3;
const REFUND_WORDS = new Set(['refund', 'refunds', 'money', 'credit', 'reimbursement']);
/** Things a customer can "receive" that are not the goods. */
const NOT_GOODS = new Set(['reply', 'response', 'email', 'answer', 'update', 'call', 'confirmation', 'message', 'return', 'invoice', 'receipt']);
const PARTIAL_WORDS = new Set(['half', 'partially', 'partial']);
const PARTIAL_BIGRAMS: readonly [string, string][] = [['part', 'of'], ['some', 'of'], ['one', 'of']];
/** Labels a question cannot assert. */
const NOT_IN_QUESTIONS = new Set<MessageLabel>(['acknowledged-receipt', 'denied-receipt', 'acknowledged-refund', 'refund-not-received']);

interface Token {
  word: string;
  start: number;
  end: number;
}

const IRREGULAR_NOT: Record<string, string> = { won: 'will', can: 'can', ca: 'can', shan: 'shall' };
const CLITICS: Record<string, string> = { "'m": 'am', "'re": 'are', "'ll": 'will', "'ve": 'have', "'d": 'would' };

/** Split into lower-case word tokens with offsets, expanding contractions ("haven't" → have, not). */
function tokenize(text: string): Token[] {
  const normalised = text.replace(/[‘’]/g, "'"); // same length, so offsets still line up
  const out: Token[] = [];
  for (const m of normalised.matchAll(/[a-z0-9]+(?:'[a-z]+)?|[.,!?;:]/gi)) {
    const raw = m[0].toLowerCase();
    const start = m.index;
    const end = start + raw.length;
    const push = (word: string) => out.push({ word, start, end });
    if (raw.endsWith("n't")) {
      const base = raw.slice(0, -3);
      push(IRREGULAR_NOT[base] ?? base);
      push('not');
    } else {
      const clitic = Object.keys(CLITICS).find((c) => raw.endsWith(c));
      if (clitic) {
        push(raw.slice(0, -clitic.length));
        push(CLITICS[clitic]!);
      } else {
        push(raw.replace(/'s$/, ''));
      }
    }
  }
  return out;
}

const ENTRY_TOKENS = LEXICON.map((e) => ({ entry: e, words: e.phrase.split(' ') }));

/** Indices of the words before `from` in the same clause, nearest first, at most `limit` of them. */
function clauseBefore(tokens: readonly Token[], from: number, limit: number): number[] {
  const out: number[] = [];
  for (let i = from - 1; i >= 0 && out.length < limit; i--) {
    if (CLAUSE_BREAKS.has(tokens[i]!.word)) break;
    out.push(i);
  }
  return out;
}

/** Indices of the words after `to` (exclusive end) in the same clause, nearest first. */
function clauseAfter(tokens: readonly Token[], to: number, limit: number): number[] {
  const out: number[] = [];
  for (let i = to; i < tokens.length && out.length < limit; i++) {
    if (CLAUSE_BREAKS.has(tokens[i]!.word)) break;
    out.push(i);
  }
  return out;
}

const isNegated = (tokens: readonly Token[], from: number): boolean =>
  clauseBefore(tokens, from, NEGATION_WINDOW).some((i) => NEGATORS.has(tokens[i]!.word));

const isQuestion = (tokens: readonly Token[], to: number): boolean => {
  for (let i = to; i < tokens.length; i++) if (SENTENCE_ENDS.has(tokens[i]!.word)) return tokens[i]!.word === '?';
  return false;
};

const aboutRefund = (tokens: readonly Token[], from: number, to: number): boolean =>
  [...clauseBefore(tokens, from, TOPIC_BACK), ...clauseAfter(tokens, to, TOPIC_AHEAD)].some((i) => REFUND_WORDS.has(tokens[i]!.word));

const aboutSomethingElse = (tokens: readonly Token[], to: number): boolean =>
  clauseAfter(tokens, to, TOPIC_AHEAD).some((i) => NOT_GOODS.has(tokens[i]!.word));

/** Where a partial-delivery qualifier starts ("half of my order arrived"), or null. */
function partialFrom(tokens: readonly Token[], from: number): number | null {
  const before = clauseBefore(tokens, from, TOPIC_BACK);
  let found: number | null = null;
  for (const i of before) {
    const w = tokens[i]!.word;
    const next = tokens[i + 1]?.word;
    if (PARTIAL_WORDS.has(w) || PARTIAL_BIGRAMS.some(([a, b]) => a === w && b === next)) found = i;
  }
  return found;
}

export function classifyMessage(text: string): LabelMatch[] {
  const tokens = tokenize(text);
  const candidates: { from: number; to: number; entry: Entry }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    for (const { entry, words } of ENTRY_TOKENS) {
      if (i + words.length > tokens.length) continue;
      if (!words.every((w, k) => tokens[i + k]!.word === w)) continue;
      const next = tokens[i + words.length]?.word;
      if (entry.notBefore && next !== undefined && entry.notBefore.includes(next)) continue;
      candidates.push({ from: i, to: i + words.length, entry });
    }
  }

  // Longest phrase wins where matches overlap ("thanks for the refund" over a shorter match inside it).
  candidates.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from);
  const taken: boolean[] = new Array(tokens.length).fill(false);
  const results: LabelMatch[] = [];
  for (const c of candidates) {
    if (taken.slice(c.from, c.to).some(Boolean)) continue;
    for (let k = c.from; k < c.to; k++) taken[k] = true;
    const negated = isNegated(tokens, c.from);
    let label = negated ? c.entry.negated : c.entry.label;
    if (!label) continue;
    let from = c.from;

    if (c.entry.receiptVerb) {
      if (aboutSomethingElse(tokens, c.to)) continue;
      if (aboutRefund(tokens, c.from, c.to)) {
        label = label === 'acknowledged-receipt' ? 'acknowledged-refund' : 'refund-not-received';
      } else if (label === 'acknowledged-receipt') {
        const partial = partialFrom(tokens, c.from);
        if (partial !== null) {
          label = 'complained';
          from = partial;
        }
      }
    }
    if (NOT_IN_QUESTIONS.has(label) && !c.entry.inQuestion && isQuestion(tokens, c.to)) continue;

    const start = tokens[from]!.start;
    const end = tokens[c.to - 1]!.end;
    results.push({ label, phrase: text.slice(start, end), start, end, negated });
  }
  return results.sort((a, b) => a.start - b.start);
}
