/** Brevo caps the complete email at 20 MB. Reserve 2 MB for headers/MIME framing. */
export const OUTBOUND_SAFE_MAX_BYTES = 18_000_000;
/** Decimal MB, measured after attachment encoding; exactly 10 MB remains regular. */
export const OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES = 10_000_000;
export function estimateEmailBytes(
  html: string,
  text: string,
  subject: string,
  attachmentSizes: readonly number[],
): number {
  const byteLength = (value: string): number =>
    Array.from(value).reduce((size, character) => {
      const point = character.codePointAt(0) ?? 0;
      return size + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
    }, 0);
  // Base64 plus MIME line wrapping; measure UTF-8, not JS string length.
  return (
    byteLength(html + text + subject) +
    8192 +
    attachmentSizes.reduce((total, size) => total + Math.ceil(size / 3) * 4 * 1.04 + 2048, 0)
  );
}
