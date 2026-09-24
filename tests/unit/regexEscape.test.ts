import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../../src/lib/regexEscape.js';

/** Tests unitarios del helper `escapeRegExp` de `src/lib/regexEscape.ts`. */

describe('escapeRegExp', () => {
  it('escapes every regex metacharacter', () => {
    const raw = '.*+?^${}()|[]\\';
    const escaped = escapeRegExp(raw);

    expect(escaped).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
    // Volver a parsear el string escapado como regex debe matchear el texto crudo literalmente.
    expect(new RegExp(`^${escaped}$`).test(raw)).toBe(true);
  });

  it('leaves ordinary alphanumeric characters untouched', () => {
    expect(escapeRegExp('bitcoin2')).toBe('bitcoin2');
  });

  it('does not let a crafted input cause catastrophic backtracking when anchored', () => {
    const malicious = '(a+)+$';
    const escaped = escapeRegExp(malicious);
    const pattern = new RegExp(`^${escaped}`);

    const start = Date.now();
    expect(pattern.test('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')).toBe(
      false,
    );
    expect(Date.now() - start).toBeLessThan(100);
  });
});
