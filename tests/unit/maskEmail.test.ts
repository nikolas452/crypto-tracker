import { describe, expect, it } from 'vitest';
import { maskEmail } from '../../src/lib/maskEmail.js';

/** Tests unitarios del helper de enmascarado de emails de `src/lib/maskEmail.ts`. */

describe('maskEmail', () => {
  it('keeps only the first character of the local part and the full domain', () => {
    expect(maskEmail('nicolas@example.com')).toBe('n***@example.com');
  });

  it('handles a one-character local part', () => {
    expect(maskEmail('n@example.com')).toBe('n***@example.com');
  });

  it('never returns the original email unmasked', () => {
    const email = 'someone@example.com';
    expect(maskEmail(email)).not.toBe(email);
    expect(maskEmail(email)).not.toContain('someone');
  });

  it('falls back to a fixed mask for a malformed value with no @', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
