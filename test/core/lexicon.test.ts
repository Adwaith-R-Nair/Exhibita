import { describe, expect, it } from 'vitest';
import { classifyMessage, type MessageLabel } from '../../src/core/classify/lexicon';

const labels = (text: string): MessageLabel[] => [...new Set(classifyMessage(text).map((m) => m.label))].sort();

describe('classifyMessage', () => {
  it.each<[string, MessageLabel[]]>([
    ['Got it, thanks!', ['acknowledged-receipt']],
    ['The package arrived this morning, all good.', ['acknowledged-receipt']],
    ['I received my order yesterday', ['acknowledged-receipt']],
    ['It never arrived.', ['denied-receipt']],
    ["I haven't received anything yet", ['denied-receipt']],
    ['I did not receive my order', ['denied-receipt']],
    ['Where is my order? Still waiting.', ['denied-receipt']],
    ['It arrived broken and I want a refund', ['acknowledged-receipt', 'complained', 'requested-refund']],
    ['This is not as described at all', ['complained']],
    ['The item is defective', ['complained']],
    ["I'm not happy with this", ['complained']],
    ["I'll just call my bank and dispute it", ['mentioned-bank']],
    ['I will file a chargeback', ['mentioned-bank']],
    ['Thanks for the refund, it came through', ['acknowledged-refund']],
    ['Can I get my money back?', ['requested-refund']],
    ['Hi, just checking my invoice address.', []],
  ])('%s', (text, expected) => {
    expect(labels(text)).toEqual(expected);
  });

  describe('reviewer phrasings (review B1)', () => {
    it.each<[string, MessageLabel[]]>([
      // "yet" does not end the negation.
      ['It has not yet arrived', ['denied-receipt']],
      ['I have not yet received it', ['denied-receipt']],
      ['Not yet received', ['denied-receipt']],
      // More ways to say it never came.
      ['It was never delivered', ['denied-receipt']],
      ['The parcel did not arrive', ['denied-receipt']],
      ["It didn't arrive", ['denied-receipt']],
      ['It never came', ['denied-receipt']],
      ["It hasn't come", ['denied-receipt']],
      ["I still haven't gotten it", ['denied-receipt']],
      ['I did not get the package', ['denied-receipt']],
      ['It never showed up', ['denied-receipt']],
      ['My package is missing', ['denied-receipt']],
      ['The order went missing', ['denied-receipt']],
      ['It showed up today', ['acknowledged-receipt']],
      // Questions assert nothing.
      ['Has it arrived yet?', []],
      ['Did it arrive?', []],
      ['Have you received my return?', []],
      // About the refund, not the goods.
      ["My refund hasn't arrived", ['refund-not-received']],
      ['My refund still has not arrived on my card.', ['refund-not-received']],
      ["I haven't received my refund", ['refund-not-received']],
      ['Has my refund arrived?', []],
      ['Where is my refund?', ['refund-not-received']],
      ['Still no sign of my refund.', ['refund-not-received']],
      ['My refund arrived, thanks', ['acknowledged-refund']],
      // "Got it" that is not about a parcel.
      ['I got it working', []],
      ['I got it wrong, sorry', []],
      ["I can't get it to work", ['complained']],
      // Receipt that is really a complaint.
      ['The box arrived empty', ['complained']],
      ['Only half of my order arrived', ['complained']],
      // Complaint phrases.
      ['The screen is cracked', ['complained']],
      ['It came broken', ['complained']],
      ['The handle was damaged', ['complained']],
      ["It doesn't match the photos", ['complained']],
      ['It does not match the description', ['complained']],
      ['The colour is nothing like the listing', ['complained']],
      // Refund requests.
      ["I'd like a refund", ['requested-refund']],
      ['Please refund me', ['requested-refund']],
      ['I demand a refund', ['requested-refund']],
      // Cancellation (Visa 13.2).
      ['I cancelled my subscription', ['cancelled']],
      ['I canceled last week', ['cancelled']],
      ['Please cancel my subscription', ['cancelled']],
      ['I never cancelled anything', []],
      // Not about the goods at all.
      ["I haven't received a reply to my email", []],
    ])('%s', (text, expected) => {
      expect(labels(text)).toEqual(expected);
    });

    it('quotes the whole partial-delivery phrase', () => {
      const [m] = classifyMessage('Only half of my order arrived');
      expect(m).toMatchObject({ label: 'complained', phrase: 'half of my order arrived' });
    });
  });

  describe('negation', () => {
    it('does not treat "not broken" as a complaint', () => {
      expect(labels('Good news, it is not broken after all')).toEqual([]);
    });

    it('does not treat "no refund needed" as a refund request', () => {
      expect(labels('No refund needed, I will keep it')).toEqual([]);
    });

    it("does not treat \"don't want a refund\" as a refund request", () => {
      expect(labels("I don't want a refund")).toEqual([]);
    });

    it('stops negation at a clause boundary', () => {
      expect(labels("It wasn't easy to open, but it arrived fine")).toEqual(['acknowledged-receipt']);
    });

    it('only looks a few words back', () => {
      expect(labels('Not sure why the tracking was late but the box arrived')).toEqual(['acknowledged-receipt']);
    });

    it('still flags a bank mention even when negated, because it signals dispute risk', () => {
      expect(labels("I don't want to go to my bank over this")).toEqual(['mentioned-bank']);
    });
  });

  it('returns the matched phrase and its position for citation', () => {
    const [m] = classifyMessage('Hello. Got it, thanks!');
    expect(m).toMatchObject({ label: 'acknowledged-receipt', phrase: 'Got it' });
    expect('Hello. Got it, thanks!'.slice(m!.start, m!.end)).toBe('Got it');
  });

  it('prefers the longer phrase when two overlap', () => {
    const found = classifyMessage('thanks for the refund');
    expect(found.map((m) => m.label)).toEqual(['acknowledged-refund']);
  });

  it('handles curly apostrophes and odd spacing', () => {
    expect(labels('I haven’t   received   it')).toEqual(['denied-receipt']);
  });

  it('is deterministic', () => {
    const t = 'It arrived broken and I want a refund';
    expect(classifyMessage(t)).toEqual(classifyMessage(t));
  });
});
