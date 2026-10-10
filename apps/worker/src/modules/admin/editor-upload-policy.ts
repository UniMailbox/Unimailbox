import { EDITOR_IMAGE_MAX_BYTES, type EditorUploadPolicy } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { readSystemSettings } from './settings-repository';

/** Safe projection for mailbox users and signature editors; no administrative settings leak. */
export async function getEditorUploadPolicy(db: Database): Promise<EditorUploadPolicy> {
  const { settings } = await readSystemSettings(db);
  return {
    maxFileBytes: settings.maxAttachmentBytes,
    maxImageBytes: Math.min(EDITOR_IMAGE_MAX_BYTES, settings.maxAttachmentBytes),
  };
}
