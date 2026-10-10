import { editorUploadPolicySchema } from '@unimailbox/contracts';
import type { ApiClient } from '../../infrastructure/api/client';

export const editorUploadPolicyKey = ['editor-upload-policy'] as const;
export async function fetchEditorUploadPolicy(api: ApiClient, signal?: AbortSignal) {
  const response = await api.fetch<{ data: unknown }>('/api/v1/editor-assets/policy', {
    ...(signal ? { signal } : {}),
  });
  return editorUploadPolicySchema.parse(response.data);
}

/** Match the binary MB/KB units used by the system settings form. */
export function formatEditorUploadLimit(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} B`;
}
