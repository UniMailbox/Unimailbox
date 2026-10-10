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

it('preserves hosted images and entities without accepting embedded or executable images', () => {
  const html = sanitizeSignatureHtml(
    '<p>A &amp; B</p><img src="https://mail.example.com/image" alt="Logo" onerror="x"><img src="data:image/svg+xml,x"><img src="//evil.test/a"><img src="javascript:x">',
  );
  expect(html).toContain('<p>A &amp; B</p>');
  expect(html).toContain('src="https://mail.example.com/image"');
  expect(html).toContain('alt="Logo"');
  expect(html).not.toMatch(/data:|evil|javascript|onerror/);
});

it('keeps bounded mail formatting while removing arbitrary CSS and CSS URLs', () => {
  const html = sanitizeSignatureHtml(
    '<h2 style="margin-left:32px;text-align:center;line-height:2;position:fixed;background:url(https://evil.test/x)"><span style="font-size:24px;color:red">Heading</span></h2><p style="margin-left:9999px;line-height:99"><span style="font-size:999px">Body</span></p>',
  );
  expect(html).toContain('margin-left:32px');
  expect(html).toContain('text-align:center');
  expect(html).toContain('line-height:2');
  expect(html).toContain('font-size:24px');
  expect(html).not.toMatch(/position|background|url|evil|color|999|99/);
});
