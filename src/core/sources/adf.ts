// Atlassian Document Format to plain text, so customer messages from Jira can be classified and quoted.

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'listItem', 'tableRow', 'panel', 'rule']);

/** Text of an ADF document: block nodes become lines, hard breaks become newlines, marks are dropped. */
export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return doc;
  const lines: string[] = [];
  let line = '';
  const walk = (node: AdfNode): void => {
    if (node.type === 'text' && typeof node.text === 'string') line += node.text;
    else if (node.type === 'hardBreak') line += '\n';
    else if (node.type === 'mention') line += String(node.attrs?.text ?? '');
    for (const child of node.content ?? []) walk(child);
    if (node.type && BLOCKS.has(node.type)) {
      lines.push(line);
      line = '';
    }
  };
  if (doc && typeof doc === 'object') walk(doc as AdfNode);
  if (line) lines.push(line);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
