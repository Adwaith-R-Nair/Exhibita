// Support ticket comments are written by the app on the customer's or agent's behalf, so each carries
// a readable header saying who wrote it and when. The header is not the customer's words: it is
// stripped before classification, so quotes and labels come only from what the customer wrote.

import type { TicketMessage } from './types';

export function withMessageHeader(m: TicketMessage): string {
  return `${m.author === 'customer' ? 'Customer' : 'Support'} (${m.at.slice(0, 16).replace('T', ' ')} UTC):\n${m.text}`;
}

const HEADER = /^(Customer|Support) \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\):\n/;

export function stripMessageHeader(text: string): string {
  return text.replace(HEADER, '');
}
