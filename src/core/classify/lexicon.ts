// Customer-message classifier: a phrase lexicon with negation handling (D-02).
// No model, no network call. Every label it produces is an Inference, never a Fact, and carries
// the exact phrase it matched so the UI can quote it.

export type MessageLabel =
  | 'acknowledged-receipt'
  | 'denied-receipt'
  | 'complained'
  | 'requested-refund'
  | 'acknowledged-refund'
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
}

const receipt = (phrase: string): Entry => ({ phrase, label: 'acknowledged-receipt', negated: 'denied-receipt' });
const receiptIfNegated = (phrase: string): Entry => ({ phrase, label: null, negated: 'denied-receipt' });
const complaint = (phrase: string): Entry => ({ phrase, label: 'complained', negated: null });
const refundRequest = (phrase: string): Entry => ({ phrase, label: 'requested-refund', negated: null });
const refundThanks = (phrase: string): Entry => ({ phrase, label: 'acknowledged-refund', negated: null });
/** A bank mention signals dispute risk whether or not it is negated ("I don't want to call my bank"). */
const bank = (phrase: string): Entry => ({ phrase, label: 'mentioned-bank', negated: 'mentioned-bank' });

const LEXICON: readonly Entry[] = [
  ...['got it', 'got the package', 'got my order', 'got my package', 'got the item', 'received it',
    'received my order', 'received the order', 'received the package', 'received my package',
    'received the item', 'arrived', 'came today', 'picked it up', 'have it now'].map(receipt),
  ...['received', 'receive', 'get it', 'have it', 'got anything', 'received anything'].map(receiptIfNegated),
  { phrase: 'where is my order', label: 'denied-receipt', negated: null },
  { phrase: 'where is my package', label: 'denied-receipt', negated: null },
  { phrase: 'still waiting', label: 'denied-receipt', negated: null },
  { phrase: 'lost in the mail', label: 'denied-receipt', negated: null },
  ...['broken', 'damaged', 'defective', 'faulty', 'not as described', 'not what i ordered', 'wrong item',
    'wrong size', 'poor quality', 'disappointed', 'unhappy', 'not happy', 'terrible', 'misleading',
    'does not work', 'not working', 'stopped working', 'fake', 'scam', 'ripped off', 'complaint'].map(complaint),
  ...['want a refund', 'want my refund', 'get a refund', 'need a refund', 'request a refund', 'requesting a refund',
    'refund please', 'refund me', 'issue a refund', 'give me a refund', 'money back', 'return it',
    'send it back', 'want to return'].map(refundRequest),
  ...['thanks for the refund', 'thank you for the refund', 'refund came through', 'got the refund',
    'got my refund', 'received the refund', 'received my refund', 'refund arrived'].map(refundThanks),
  ...['bank', 'chargeback', 'charge back', 'dispute', 'disputing', 'disputed', 'card company',
    'unauthorized', 'unauthorised', 'fraud', 'fraudulent', 'report you', 'file a claim'].map(bank),
];

const NEGATORS = new Set(['not', 'no', 'never', 'without', 'nothing', 'none', 'nor', 'neither']);
const CLAUSE_BREAKS = new Set(['but', 'however', 'although', 'though', 'yet', '.', ',', '!', '?', ';', ':']);
const NEGATION_WINDOW = 3;

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

function isNegated(tokens: readonly Token[], startIndex: number): boolean {
  for (let i = startIndex - 1, seen = 0; i >= 0 && seen < NEGATION_WINDOW; i--, seen++) {
    const w = tokens[i]!.word;
    if (CLAUSE_BREAKS.has(w)) return false;
    if (NEGATORS.has(w)) return true;
  }
  return false;
}

export function classifyMessage(text: string): LabelMatch[] {
  const tokens = tokenize(text);
  const candidates: { from: number; to: number; entry: Entry }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    for (const { entry, words } of ENTRY_TOKENS) {
      if (i + words.length > tokens.length) continue;
      if (words.every((w, k) => tokens[i + k]!.word === w)) candidates.push({ from: i, to: i + words.length, entry });
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
    const label = negated ? c.entry.negated : c.entry.label;
    if (!label) continue;
    const start = tokens[c.from]!.start;
    const end = tokens[c.to - 1]!.end;
    results.push({ label, phrase: text.slice(start, end), start, end, negated });
  }
  return results.sort((a, b) => a.start - b.start);
}
