import { describe, expect, it } from "vitest";
import { redactText, wrapUntrustedEmail } from "../../../src/modules/mcp/pii";

describe("redactText", () => {
  it("redacts an email address", () => {
    expect(redactText("Contact alice@example.com for details")).toBe(
      "Contact [email] for details",
    );
  });

  it("redacts a CN mobile phone number", () => {
    expect(redactText("Reach me at 13800138000 today")).toBe(
      "Reach me at [phone-cn] today",
    );
  });

  it("leaves short digit runs untouched (postal codes, order numbers)", () => {
    // 12-digit order ID is below the Luhn-detection range.
    expect(redactText("Order #123456789012")).toBe("Order #123456789012");
  });

  it("redacts long digit runs that pass the Luhn check", () => {
    // 16-digit Visa test number that passes Luhn.
    expect(redactText("Card 4111111111111111 issued")).toBe(
      "Card [card] issued",
    );
  });

  it("keeps long digit runs that fail Luhn intact", () => {
    // 16-digit run that fails Luhn: should NOT be redacted.
    expect(redactText("Tracking 1234567890123456 ready")).toBe(
      "Tracking 1234567890123456 ready",
    );
  });

  it("redacts an 18-digit CN resident ID (with X checksum)", () => {
    expect(redactText("ID 11010519491231002X used")).toBe("ID [id-cn] used");
  });

  it("redacts an IPv4 address", () => {
    expect(redactText("Server at 10.0.0.1 responded")).toBe(
      "Server at [ip] responded",
    );
  });

  it("respects the allow-list for quoted addresses", () => {
    expect(
      redactText("Reply to alice@example.com please", ["alice@example.com"]),
    ).toBe("Reply to alice@example.com please");
  });

  it("applies all patterns in one pass", () => {
    const out = redactText(
      "From bob@x.test to 13912345678 card 4111111111111111 IP 8.8.8.8 ID 11010519491231002X",
    );
    expect(out).not.toContain("bob@x.test");
    expect(out).not.toContain("13912345678");
    expect(out).not.toContain("4111111111111111");
    expect(out).not.toContain("8.8.8.8");
    expect(out).not.toContain("11010519491231002X");
    expect(out).toContain("[email]");
    expect(out).toContain("[phone-cn]");
    expect(out).toContain("[card]");
    expect(out).toContain("[ip]");
    expect(out).toContain("[id-cn]");
  });

  it("is a no-op on a clean string", () => {
    expect(redactText("Hello world, no PII here.")).toBe(
      "Hello world, no PII here.",
    );
  });

  it("handles multiple matches of the same pattern in one string", () => {
    expect(redactText("a@x.test and b@x.test")).toBe("[email] and [email]");
  });
});

describe("wrapUntrustedEmail", () => {
  it("wraps the body with the sentinel pair on dedicated lines", () => {
    const out = wrapUntrustedEmail("hello there");
    expect(out).toBe("BEGIN_UNTRUSTED_EMAIL\nhello there\nEND_UNTRUSTED_EMAIL");
  });

  it("preserves multi-line bodies", () => {
    const out = wrapUntrustedEmail("line1\nline2");
    expect(out).toContain(
      "BEGIN_UNTRUSTED_EMAIL\nline1\nline2\nEND_UNTRUSTED_EMAIL",
    );
  });

  it("returns empty-string body untouched", () => {
    expect(wrapUntrustedEmail("")).toBe(
      "BEGIN_UNTRUSTED_EMAIL\n\nEND_UNTRUSTED_EMAIL",
    );
  });
});
