import { AppError } from '@/contracts/errors';

/** assets use cases. Route Handlers and MCP tools may only enter through this layer. */
export function notImplemented(name: string): never {
  throw new AppError('not_implemented', `${name} is not implemented yet`);
}

export {
  countWorkspaceAssets,
  listWorkspaceAssets,
  type WorkspaceAssetRow,
} from './workspace';
export {
  countPublicAssets,
  listPublicAssets,
  listPublicAssetLocations,
  publicAssetDetail,
  publicAssetHeading,
  CATALOG_PAGE_SIZE,
  POPULARITY_WINDOW_DAYS,
  type CatalogEntry,
  type PublicAssetDetail,
  type PublicAssetLocation,
  type PublicAssetSource,
  type PublicAssetVersion,
} from './catalog';
export {
  prepareUploads,
  preparePlatformUploads,
  type PreparedUpload,
  type PrepareUploadsInput,
} from './uploads';
export {
  assetFiles,
  updateAssetFiles,
  type AssetFilesView,
  type UpdateAssetFilesInput,
  type UpdateAssetFilesResult,
} from './files';
export {
  confirmUploads,
  createWorkspaceAsset,
  type CreateWorkspaceAssetInput,
  type CreateWorkspaceAssetResult,
} from './create';
export {
  canDeleteAssets,
  canManageApiKeys,
  canManageAssets,
  deleteWorkspaceAsset,
  markAssetDeleted,
  DELETE_OPERATION,
  type DeleteAssetResult,
  type DeleteWorkspaceAssetInput,
  type WorkspaceRole,
} from './delete';
export { workspaceAssetDetail, type WorkspaceAssetDetail } from './detail';
export {
  assetUsageCounts,
  assetUsageLog,
  ASSET_USAGE_PAGE_SIZE,
  type AssetUsageCount,
  type AssetUsageEntry,
  type AssetUsageLog,
} from './usage';
export {
  declareAssetRights,
  assetMaterials,
  type DeclareRightsInput,
  type AssetMaterials,
} from './materials';
export { requestAssetRebuild, type RebuildResult } from './rebuild';
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
  editAssetMetadata,
  updateParseScope,
  type EditAssetMetadataInput,
  type EditAssetMetadataResult,
  type OwnerLifecycleInput,
  type OwnerLifecycleResult,
  type UpdateParseScopeInput,
  type UpdateParseScopeResult,
} from './manage';
