import { describe, expect, it } from 'vitest';
import { readBoundedBody } from './attachments';

function requestWithBody(body: ReadableStream<Uint8Array>): Request {
  return { body } as unknown as Request;
}

describe('readBoundedBody', () => {
  it('R-API-005 cancels a stream as soon as it crosses the cap', async () => {
    const maxBytes = 4;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(maxBytes));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedBody(requestWithBody(stream), maxBytes)).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
      httpStatus: 413,
    });
    expect(cancelled).toBe(true);
  });

  it('R-API-005 preserves binary bytes at or below the cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255]));
        controller.enqueue(new Uint8Array([1, 254]));
        controller.close();
      },
    });

    const bytes = await readBoundedBody(requestWithBody(stream), 4);
    expect(Array.from(new Uint8Array(bytes))).toEqual([0, 255, 1, 254]);
  });
});
