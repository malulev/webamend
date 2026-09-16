import { describe, expect, it } from 'vitest';

import { formatMessage, placeholdersOf, splitMessage } from '@/lib/i18n';

describe('formatMessage', () => {
  it('fills each placeholder with the value given for it', () => {
    expect(formatMessage('Remove {name}', { name: 'logo.png' })).toBe('Remove logo.png');
    expect(formatMessage('Tell {name} about {name}', { name: 'Webamend' })).toBe(
      'Tell Webamend about Webamend',
    );
  });

  it('leaves a placeholder nothing was given for as written, so the gap is visible', () => {
    expect(formatMessage('Remove {name}')).toBe('Remove {name}');
    expect(formatMessage('If {email} may edit, {n} left', { email: 'a@b.c' })).toBe(
      'If a@b.c may edit, {n} left',
    );
  });

  it('writes numbers as text', () => {
    expect(formatMessage('Updated {n} min ago', { n: 5 })).toBe('Updated 5 min ago');
    expect(formatMessage('{n}', { n: 0 })).toBe('0');
  });

  it('touches nothing that is not a placeholder', () => {
    expect(formatMessage('no braces here', { n: 1 })).toBe('no braces here');
    expect(formatMessage('{ not one } {1bad}', { n: 1 })).toBe('{ not one } {1bad}');
  });
});

describe('placeholdersOf', () => {
  it('lists each placeholder once, in order of first appearance', () => {
    expect(placeholdersOf('{email} and {name}, then {email} again')).toEqual(['email', 'name']);
  });

  it('is empty for a sentence with no moving parts', () => {
    expect(placeholdersOf('Nothing here yet.')).toEqual([]);
  });
});

describe('splitMessage', () => {
  it('cuts a sentence into text and parameters that join back into the same sentence', () => {
    const template = 'If {email} is allowed, a link is on its way.';
    const parts = splitMessage(template);
    expect(parts).toEqual([
      { kind: 'text', value: 'If ' },
      { kind: 'param', value: 'email' },
      { kind: 'text', value: ' is allowed, a link is on its way.' },
    ]);
    const rejoined = parts
      .map((part) => (part.kind === 'param' ? `{${part.value}}` : part.value))
      .join('');
    expect(rejoined).toBe(template);
  });

  it('handles placeholders at either end and back to back', () => {
    expect(splitMessage('{name}')).toEqual([{ kind: 'param', value: 'name' }]);
    expect(splitMessage('{a}{b}')).toEqual([
      { kind: 'param', value: 'a' },
      { kind: 'param', value: 'b' },
    ]);
    expect(splitMessage('plain')).toEqual([{ kind: 'text', value: 'plain' }]);
  });

  it('names the same parameters placeholdersOf finds, in the same order', () => {
    const template = 'Tell {name} what {email} wants; {name} listens.';
    const params = splitMessage(template)
      .filter((part) => part.kind === 'param')
      .map((part) => part.value);
    expect([...new Set(params)]).toEqual(placeholdersOf(template));
  });
});
