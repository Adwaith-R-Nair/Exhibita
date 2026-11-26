import { describe, expect, it } from 'vitest';
import { adfToText } from '../../src/core/sources/adf';
import { stripMessageHeader, withMessageHeader } from '../../src/core/sources/ticket-text';

const adf = (text: string) => ({ type: 'doc', version: 1, content: text.split('\n').map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })) });

describe('ticket message headers', () => {
  it('round-trips through Jira comment text back to exactly what the customer wrote', () => {
    const m = { author: 'customer' as const, at: '2026-10-20T09:15:00.000Z', text: "Still no refund.\nI'll call my bank." };
    const stored = withMessageHeader(m);
    expect(stored.startsWith('Customer (2026-10-20 09:15 UTC):\n')).toBe(true);
    expect(stripMessageHeader(adfToText(adf(stored)))).toBe(m.text);
  });

  it('leaves text without a header alone', () => {
    expect(stripMessageHeader('Customer service was great')).toBe('Customer service was great');
  });
});
