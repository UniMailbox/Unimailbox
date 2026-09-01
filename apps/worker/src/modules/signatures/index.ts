// modules/signatures — CAP-068 public surface.
// Depends on: tenancy, platform, and the contracts audit seam.
export {
  createAdminSignature,
  deleteAdminSignature,
  findEnabledSignature,
  listAdminSignatures,
  updateAdminSignature,
  type CreateAdminSignatureInput,
  type DeleteAdminSignatureInput,
  type SignatureAdministrationDependencies,
  type SignatureAdministrationResult,
  type UpdateAdminSignatureInput,
} from './signature-administration-service';
export {
  findSignatureById,
  findSignatureByDomainId,
  listSignatures,
  prepareCreateSignature,
  prepareDeleteSignature,
  prepareRequireSignatureDeleted,
  prepareRequireSignatureUpdated,
  prepareUpdateSignature,
  type CreateSignatureStorageInput,
  type SignatureStorageRow,
  type UpdateSignatureStorageInput,
} from './signature-repository';
export { sanitizeSignatureHtml } from './signature-sanitizer';
