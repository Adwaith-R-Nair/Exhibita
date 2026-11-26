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
