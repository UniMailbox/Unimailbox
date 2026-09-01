import { describe, expect, it } from 'vitest';
import { sanitizeSignatureHtml } from './signature-sanitizer';

describe('sanitizeSignatureHtml (CAP-068)', () => {
  it('keeps the small formatting allowlist and safe links only', () => {
    expect(
      sanitizeSignatureHtml(
        '<p class="x" onclick="alert(1)"><strong>Regards</strong><br><a href="https://example.com" target="_blank">Site</a><a href="mailto:team@example.com">Mail</a></p>',
      ),
    ).toBe(
      '<p><strong>Regards</strong><br><a href="https://example.com">Site</a><a href="mailto:team@example.com">Mail</a></p>',
    );
  });

  it('removes executable markup, dangerous links, comments, and unknown tags', () => {
    const sanitized = sanitizeSignatureHtml(
      '<script>alert(1)</script><style>.x{display:none}</style><!-- comment --><img src="x" onerror="alert(2)"><a href="javascript:alert(3)" onmouseover="x">unsafe</a><custom>safe text</custom>',
    );
    expect(sanitized).toBe('<a>unsafe</a>safe text');
    expect(sanitized).not.toMatch(/script|style|onerror|javascript|custom/i);
  });

  it('escapes plain text and rejects control-character link obfuscation', () => {
    expect(sanitizeSignatureHtml('5 < 6 & 7 > 3')).toBe('5 &lt; 6 &amp; 7 &gt; 3');
    expect(sanitizeSignatureHtml('<a href="java\u0000script:alert(1)">x</a>')).toBe('<a>x</a>');
  });
});
