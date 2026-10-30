import { AppError } from '@/contracts/errors';

/** libraries use cases. Route Handlers and MCP tools may only enter through this layer. */
export function notImplemented(name: string): never {
  throw new AppError('not_implemented', `${name} is not implemented yet`);
}

export {
  countWorkspaceLibraries,
  listWorkspaceLibraries,
  type WorkspaceLibraryRow,
} from './workspace';
export {
  countPublicLibraries,
  listPublicLibraries,
  listPublicLibraryLocations,
  publicLibraryDetail,
  publicLibraryHeading,
  CATALOG_PAGE_SIZE,
  POPULARITY_WINDOW_DAYS,
  type CatalogEntry,
  type PublicLibraryDetail,
  type PublicLibraryLocation,
  type PublicLibrarySource,
  type PublicLibraryVersion,
} from './catalog';
export {
  prepareUploads,
  preparePlatformUploads,
  type PreparedUpload,
  type PrepareUploadsInput,
} from './uploads';
export {
  libraryFiles,
  updateLibraryFiles,
  type LibraryFilesView,
  type UpdateLibraryFilesInput,
  type UpdateLibraryFilesResult,
} from './files';
export {
  confirmUploads,
  createWorkspaceLibrary,
  type CreateWorkspaceLibraryInput,
  type CreateWorkspaceLibraryResult,
} from './create';
export {
  canDeleteLibraries,
  canManageApiKeys,
  canManageLibraries,
  deleteWorkspaceLibrary,
  markLibraryDeleted,
  DELETE_OPERATION,
  type DeleteLibraryResult,
  type DeleteWorkspaceLibraryInput,
  type WorkspaceRole,
} from './delete';
export { workspaceLibraryDetail, type WorkspaceLibraryDetail } from './detail';
export {
  libraryUsageCounts,
  libraryUsageLog,
  LIBRARY_USAGE_PAGE_SIZE,
  type LibraryUsageCount,
  type LibraryUsageEntry,
  type LibraryUsageLog,
} from './usage';
export {
  declareLibraryRights,
  libraryMaterials,
  type DeclareRightsInput,
  type LibraryMaterials,
} from './materials';
export { requestLibraryRebuild, type RebuildResult } from './rebuild';
export {
  documentPreview,
  documentsPage,
  documentsPageSize,
  DOCUMENTS_PAGE_SIZE,
  DOCUMENTS_PAGE_SIZES,
  listVersionDocuments,
  type DocumentPreview,
  type VersionDocument,
} from './documents';
export {
  checkDomainVerification,
  startDomainVerification,
  type CheckDomainVerificationInput,
  type CheckDomainVerificationResult,
  type DomainChallenge,
  type StartDomainVerificationInput,
} from './domain-verification';
export {
  applyOwnerLifecycleAction,
  editLibraryMetadata,
  updateParseScope,
  type EditLibraryMetadataInput,
  type EditLibraryMetadataResult,
  type OwnerLifecycleInput,
  type OwnerLifecycleResult,
  type UpdateParseScopeInput,
  type UpdateParseScopeResult,
} from './manage';
