import { describe, expect, it } from 'vitest';
import { adfToText } from '../../src/core/sources/adf';

describe('adfToText', () => {
  it('joins paragraphs with newlines and keeps the customer wording exact', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Got it, thanks!' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'But the ' }, { type: 'text', text: 'strap', marks: [{ type: 'strong' }] }, { type: 'text', text: ' is broken.' }] },
      ],
    };
    expect(adfToText(doc)).toBe('Got it, thanks!\nBut the strap is broken.');
  });

  it('handles hard breaks, lists, plain strings and junk', () => {
    const doc = { type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] }] }] }] };
    expect(adfToText(doc)).toBe('one\ntwo');
    expect(adfToText('already text')).toBe('already text');
    expect(adfToText(null)).toBe('');
    expect(adfToText({ nonsense: true })).toBe('');
  });
});
