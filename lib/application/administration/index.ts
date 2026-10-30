import { AppError } from '@/contracts/errors';

/** administration use cases. Route Handlers and MCP tools may only enter through this layer. */
export function notImplemented(name: string): never {
  throw new AppError('not_implemented', `${name} is not implemented yet`);
}

export {
  signInAdmin,
  revokeAdminSession,
  rolesFor,
  type SignInAdminInput,
  type SignInAdminResult,
} from './sign-in-admin';
export { resolveAdminSession, type AdminSession } from './resolve-admin-session';
export { recordAudit, originDigest, auditHash, type AuditEntry } from './audit';
export { hashAdminPassword, verifyAdminPassword } from './password';
export { adminSessionTokenHash } from './admin-session-token';
export { CONSOLE_EXPORTS, isExportableResource, type ExportRequest } from './console-exports';
export { toCsv, csvCell } from './csv';
export { qrCodeSvg } from './qr-code';
export { listConsoleUsers, type ConsoleUserRow, type UserStatusFilter } from './list-users';
export {
  listAuditEntries,
  recentAuditEntries,
  type AuditList,
  type AuditListInput,
  type AuditResultFilter,
  type ConsoleAuditRow,
} from './list-audit';
export {
  listUserLibraries,
  listClaims,
  type ConsoleLibraryRow,
  type ConsoleClaimRow,
  type LibraryReviewFilter,
  type ClaimFilter,
} from './list-libraries';
export {
  consoleOverview,
  healthNeedsAttention,
  type ConsoleOverview,
  type OverviewHealth,
  type OverviewInput,
  type WindowedCount,
} from './overview';
export {
  listRefreshQueue,
  type RefreshQueue,
  type RefreshQueueCounts,
  type RefreshQueueRow,
} from './refresh-queue';
export {
  createPlatformLibrary,
  deletePlatformLibrary,
  getPlatformLibrary,
  isPlatformStatusFilter,
  listPlatformLibraries,
  platformLibrarySummary,
  requestPlatformLibraryRefresh,
  setPlatformLibraryLifecycle,
  updatePlatformLibrary,
  addPlatformLibrarySource,
  updatePlatformLibrarySource,
  updatePlatformLibraryFiles,
  type UpdatePlatformFilesResult,
  rebuildPlatformLibraryProfile,
  removePlatformLibrarySource,
  PLATFORM_STATUS_FILTERS,
  type CreatePlatformLibraryResult,
  type LifecycleChangeResult,
  type PlatformActor,
  type PlatformAuditView,
  type PlatformDeleteResult,
  type PlatformLibraryDetail,
  type PlatformLibraryList,
  type PlatformLibraryRow,
  type PlatformLibrarySummary,
  type PlatformOperationView,
  type PlatformProfileView,
  type PlatformSourceView,
  type PlatformStatusFilter,
  type PlatformVersionView,
  type ProfileRebuildResult,
  type RefreshRequestResult,
} from './manage-platform-libraries';
export {
  getConsoleUser,
  setUserAccountStatus,
  type ConsoleUserDetail,
  type UserApiKeyView,
  type UserAuditView,
  type UserLibraryView,
  type UserSessionView,
  type UserStatusChangeResult,
  type UserWorkspaceView,
} from './manage-users';
export {
  listAdministrators,
  inviteAdministrator,
  changeAdministratorRole,
  setAdministratorStatus,
  revokeAdministratorSessions,
  offerEnrolment,
  completeEnrolment,
  hasAnyAdministrator,
  offerBootstrap,
  bootstrapFirstAdministrator,
  type AdministratorRow,
  type InviteResult,
  type EnrolmentOffer,
  type BootstrapOffer,
} from './manage-administrators';
export {
  activeLlmConfig,
  llmConfigEntries,
  openLlmCredential,
  readLlmAssignment,
  readLlmConfiguration,
  recordLlmCost,
  selectableLlmModels,
  updateLlmAssignment,
  updateLlmConfig,
  LlmConfigRefused,
  type LlmAssignment,
  type LlmConfigRow,
  type LlmConfiguration,
  type LlmUsageStats,
  type UpdateLlmAssignmentInput,
} from './manage-llm-config';
export {
  probeLlmConfig,
  type LlmProbeInput,
  type LlmProbeResult,
} from './probe-llm-config';
export {
  probeModelConfig,
  type ModelProbeInput,
  type ModelProbeResult,
} from './probe-model-config';
export {
  modelAdapters,
  modelProviderStatus,
  openModelCredential,
  readModelConfiguration,
  resolveEmbeddingProvider,
  resolveModelProviders,
  resolveRerankProvider,
  updateModelConfig,
  ModelConfigRefused,
  type ModelAdapters,
  type ModelConfiguration,
  type ResolvedModelProviders,
  type ProviderModelRow,
  type UpdateModelConfigInput,
} from './manage-model-config';
export {
  probeRenderConfig,
  readRenderConfiguration,
  resolvePageRenderer,
  updateRenderConfig,
  updateRenderKeys,
  RenderConfigRefused,
  RENDER_PROBE_URL,
  type RenderConfigRow,
  type RenderConfiguration,
  type RenderKeyRow,
  type RenderProbeResult,
  type UpdateRenderConfigInput,
  type UpdateRenderKeysInput,
} from './manage-render-config';
export {
  activeRetrievalSettings,
  readRetrievalConfiguration,
  retrievalProviderStatus,
  updateRetrievalConfig,
  type ActiveRetrievalSettings,
  type RetrievalConfigRow,
  type RetrievalConfiguration,
  type UpdateRetrievalConfigInput,
} from './manage-retrieval-config';
export {
  getUserLibrary,
  reviewUserLibrary,
  MANUAL_REVIEW_STAGE,
  type ReviewResult,
  type UserLibraryDetail,
  type UserLibraryReviewView,
} from './review-libraries';
export {
  listFlaggedDocuments,
  listReviewDocuments,
  probeReviewLibrary,
  readReviewDocument,
  reviewable,
  reviewScore,
  type ProbeResult,
  type ReviewableLibrary,
  type ReviewDocument,
  type ReviewDocumentRow,
  type ReviewScore,
} from './review-content';
export {
  generateSettlements,
  isSettlementStatusFilter,
  listSettlements,
  periodParam,
  settlementPeriods,
  settlementSummary,
  SETTLEMENT_STATUS_FILTERS,
  type ConsoleSettlementRow,
  type GenerateSettlementsResult,
  type SettlementList,
  type SettlementListInput,
  type SettlementPeriodView,
  type SettlementStatus,
  type SettlementStatusFilter,
  type SettlementSummary,
} from './settlements';
export {
  consolePayouts,
  markPayoutFailed,
  markPayoutPaid,
  type ConsolePayoutRow,
  type ConsolePayouts,
  type PayoutActor,
  type ResolvedPayout,
} from './payouts';
export { resetAdministratorMfa, type MfaResetResult } from './manage-administrators';
export { revokeUserApiKey, revokeUserSession, type UserRevocation } from './manage-users';
