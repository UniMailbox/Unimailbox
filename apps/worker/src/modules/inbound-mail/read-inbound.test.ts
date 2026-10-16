import { describe, expect, it } from 'vitest';
import { INBOUND_RAW_MAX_BYTES } from '@unimailbox/contracts';
import { InboundSizeError, readInboundBytes } from './read-inbound';

describe('R-INBOUND-011 bounded raw MIME', () => {
  it('accepts the exact boundary and counts bytes across chunks', async () => {
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(INBOUND_RAW_MAX_BYTES - 1));
        controller.enqueue(new Uint8Array([255]));
        controller.close();
      },
    });
    const bytes = await readInboundBytes(raw, INBOUND_RAW_MAX_BYTES);
    expect(bytes.byteLength).toBe(INBOUND_RAW_MAX_BYTES);
    expect(new Uint8Array(bytes).at(-1)).toBe(255);
  });

  it('cancels an actual oversized stream even when the declared size is small', async () => {
    let cancelled = false;
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(INBOUND_RAW_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readInboundBytes(raw, 1)).rejects.toBeInstanceOf(InboundSizeError);
    expect(cancelled).toBe(true);
    expect(raw.locked).toBe(false);
  });

  it.each([-1, NaN, Infinity, 1.5, INBOUND_RAW_MAX_BYTES + 1])(
    'rejects invalid declared size %s before reading',
    async (size) => {
      const raw = new ReadableStream<Uint8Array>();
      await expect(readInboundBytes(raw, size)).rejects.toBeInstanceOf(InboundSizeError);
      expect(raw.locked).toBe(false);
    },
  );

  it('propagates stream failure so incomplete mail cannot be accepted', async () => {
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('transport'));
      },
    });
    await expect(readInboundBytes(raw, 0)).rejects.toThrow('transport');
    expect(raw.locked).toBe(false);
  });
});
