import { sha256 } from '@noble/hashes/sha2.js';
import { DomainError } from './errors';

/** One streaming pass into R2 with a rolling digest; large files never occupy a same-sized JS buffer. */
export async function storeEditorUpload(
  bucket: R2Bucket | null,
  key: string,
  body: ReadableStream<Uint8Array> | null,
  size: number,
): Promise<{ hash: string; prefix: Uint8Array }> {
  if (!body)
    throw new DomainError({
      code: 'VALIDATION_ERROR',
      message: 'File must not be empty',
      httpStatus: 400,
    });
  // Replays still validate and hash the actual body, without creating an R2 object.
  const stream = bucket ? new FixedLengthStream(size) : null;
  const writer = stream?.writable.getWriter();
  const reader = body.getReader();
  const digest = sha256.create();
  const prefix = new Uint8Array(12);
  let total = 0;
  const put =
    bucket && stream
      ? bucket.put(key, stream.readable).catch(async (error: unknown) => {
          await writer?.abort(error).catch(() => {});
          throw error;
        })
      : Promise.resolve(null);
  // Observe both sides immediately: a failed R2 write must not leave a blocked writer.
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total + value.byteLength > size)
          throw new Error('File size does not match upload metadata');
        if (total < prefix.length) prefix.set(value.subarray(0, prefix.length - total), total);
        total += value.byteLength;
        digest.update(value);
        await writer?.write(value);
      }
      if (total !== size) throw new Error('File size does not match upload metadata');
      await writer?.close();
    } catch (error) {
      await writer?.abort(error).catch(() => {});
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })();
  const results = await Promise.allSettled([put, pump]);
  for (const result of results)
    if (result.status === 'rejected') {
      await bucket?.delete(key).catch(() => {});
      throw new DomainError({
        code: 'VALIDATION_ERROR',
        message: 'Upload failed or file size did not match. Try again.',
        httpStatus: 400,
      });
    }
  return {
    hash: Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    prefix,
  };
}
