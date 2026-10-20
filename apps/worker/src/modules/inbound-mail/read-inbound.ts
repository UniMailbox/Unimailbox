import { INBOUND_RAW_MAX_BYTES } from '@unimailbox/contracts';

export class InboundSizeError extends Error {
  constructor() {
    super('Email exceeds the inbound size limit.');
  }
}

/** Enforce the actual stream length as well as the provider's declared rawSize. */
export async function readInboundBytes(
  raw: ReadableStream<Uint8Array>,
  rawSize: number,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(rawSize) || rawSize < 0 || rawSize > INBOUND_RAW_MAX_BYTES)
    throw new InboundSizeError();
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > INBOUND_RAW_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new InboundSizeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function inboundRawHash(raw: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
