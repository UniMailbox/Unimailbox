/**
 * @unimailbox/email-core tests — CAP-021
 * Unit tests for RFC 5322 parsing functions (pure, deterministic).
 */
import { describe, expect, it } from 'vitest';
import { parseEmail, normalizeAddress } from './index';

describe('email-core', () => {
  describe('normalizeAddress', () => {
    it('lowercases and trims the input', () => {
      expect(normalizeAddress('  User@Example.COM ')).toBe('user@example.com');
    });

    it('is idempotent', () => {
      const once = normalizeAddress('Foo@Bar.Test');
      expect(normalizeAddress(once)).toBe(once);
    });

    it('returns an empty string for an empty input', () => {
      expect(normalizeAddress('')).toBe('');
    });
  });

  describe('parseEmail', () => {
    it('parses a simple plain text email', async () => {
      const raw = `From: sender@example.com
To: recipient@example.com
Subject: Test subject

This is the body.`;

      const parsed = await parseEmail(raw);

      expect(parsed.from.address).toBe('sender@example.com');
      expect(parsed.from.name).toBe('');
      expect(parsed.to).toEqual([{ address: 'recipient@example.com', name: '' }]);
      expect(parsed.subject).toBe('Test subject');
      expect(parsed.textBody).toBe('This is the body.');
      expect(parsed.htmlBody).toBe('');
    });

    it('parses email with display name', async () => {
      const raw = `From: "John Doe" <john@example.com>
To: recipient@example.com
Subject: Hello

Body text`;

      const parsed = await parseEmail(raw);

      expect(parsed.from.address).toBe('john@example.com');
      expect(parsed.from.name).toBe('John Doe');
    });

    it('parses multiple To recipients', async () => {
      const raw = `From: sender@example.com
To: user1@example.com, user2@example.com
Subject: Test

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.to).toHaveLength(2);
      expect(parsed.to[0].address).toBe('user1@example.com');
      expect(parsed.to[1].address).toBe('user2@example.com');
    });

    it('parses Cc header', async () => {
      const raw = `From: sender@example.com
To: to@example.com
Cc: cc1@example.com, cc2@example.com
Subject: Test

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.cc).toHaveLength(2);
      expect(parsed.cc[0].address).toBe('cc1@example.com');
      expect(parsed.cc[1].address).toBe('cc2@example.com');
    });

    it('parses Message-ID header', async () => {
      const raw = `From: sender@example.com
To: recipient@example.com
Message-ID: <test@message.id>
Subject: Test

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.messageId).toBe('<test@message.id>');
    });

    it('parses In-Reply-To header', async () => {
      const raw = `From: sender@example.com
To: recipient@example.com
In-Reply-To: <original@message.id>
Subject: Re: Test

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.inReplyTo).toBe('<original@message.id>');
    });

    it('parses References header', async () => {
      const raw = `From: sender@example.com
To: recipient@example.com
References: <msg1@id> <msg2@id>
Subject: Re: Test

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.references).toBe('<msg1@id> <msg2@id>');
    });

    it('parses multipart/alternative with text and html', async () => {
      const raw = `From: sender@example.com
To: recipient@example.com
Subject: Multipart test
Content-Type: multipart/alternative; boundary=boundary123

--boundary123
Content-Type: text/plain

Plain text body
--boundary123
Content-Type: text/html

<html><body>HTML body</body></html>
--boundary123--`;

      const parsed = await parseEmail(raw);

      expect(parsed.textBody).toBe('Plain text body');
      expect(parsed.htmlBody).toBe('<html><body>HTML body</body></html>');
    });

    it('handles folded headers', async () => {
      const raw = `From: sender@example.com
To: recipient@example.com
Subject: This is a very long subject that
 might be folded across multiple lines

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.subject).toBe('This is a very long subject that might be folded across multiple lines');
    });

    it('handles quoted display names with commas', async () => {
      const raw = `From: sender@example.com
To: "Doe, John" <john@example.com>, "Smith, Jane" <jane@example.com>
Subject: Test

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.to).toHaveLength(2);
      expect(parsed.to[0].address).toBe('john@example.com');
      expect(parsed.to[0].name).toBe('Doe, John');
      expect(parsed.to[1].address).toBe('jane@example.com');
      expect(parsed.to[1].name).toBe('Smith, Jane');
    });

    it('handles empty headers gracefully', async () => {
      const raw = `From: sender@example.com
To: recipient@example.com

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.subject).toBe('');
      expect(parsed.messageId).toBeNull();
      expect(parsed.inReplyTo).toBeNull();
      expect(parsed.references).toBe('');
    });

    it('handles CRLF line endings', async () => {
      const raw = `From: sender@example.com\r
To: recipient@example.com\r
Subject: Test\r
\r
Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.from.address).toBe('sender@example.com');
      expect(parsed.to[0].address).toBe('recipient@example.com');
      expect(parsed.subject).toBe('Test');
      expect(parsed.textBody).toBe('Body');
    });

    it('lowercases addresses per R-DATA-001', async () => {
      const raw = `From: Sender@EXAMPLE.COM
To: Recipient@Example.COM
Subject: Test

Body`;

      const parsed = await parseEmail(raw);

      expect(parsed.from.address).toBe('sender@example.com');
      expect(parsed.to[0].address).toBe('recipient@example.com');
    });
  });
});
