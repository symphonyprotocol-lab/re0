/** Showcase page use cases. Route Handlers and server actions enter through this layer. */
export {
  applyShowcaseVerb,
  deleteShowcase,
  enableShowcase,
  assetShowcase,
  removeShowcaseAsset,
  showcaseAssetKey,
  ShowcaseInvalid,
  updateShowcase,
  uploadShowcaseAsset,
  type EnableShowcaseInput,
  type EnableShowcaseResult,
  type ShowcaseAssetKind,
  type ShowcaseRefusal,
  type ShowcaseView,
  type UpdateShowcaseInput,
} from './manage';
export { countWorkspaceShowcases, resetEntitlementCache, showcaseEntitlement, type WorkspaceShowcaseEntitlement } from './entitlement';
export {
  lookupShowcase,
  resolveShowcasePrincipal,
  showcaseAssetKeyFor,
  showcasePasswordFor,
  type PublicShowcase,
  type ShowcaseGateInput,
  type ShowcaseLookup,
  type ShowcasePrincipal,
} from './resolve';
export {
  noteShowcaseEvent,
  recordShowcaseEvent,
  recordShowcaseFeedback,
  showcaseStats,
  type ShowcaseEvent,
  type ShowcaseStats,
} from './events';
export {
  DRAFT_FREE_DAILY_LIMIT,
  generateShowcaseDraft,
  type GenerateShowcaseDraftInput,
  type GenerateShowcaseDraftResult,
  type ShowcaseDraftOutcome,
} from './draft';
export {
  listConsoleShowcases,
  moderateShowcase,
  SHOWCASE_CONSOLE_FILTERS,
  type ConsoleShowcaseRow,
  type ShowcaseConsoleFilter,
} from './admin';
export {
  countNewLeads,
  LeadInvalid,
  listShowcaseLeads,
  recordShowcaseLead,
  showcaseLeadsCsv,
  updateShowcaseLead,
  type RecordLeadInput,
  type ShowcaseLeadsView,
  type ShowcaseLeadView,
} from './leads';
export {
  checkShowcaseDomain,
  customDomainsAvailable,
  customHostOf,
  dropShowcaseDomainOf,
  ownHosts,
  removeShowcaseDomain,
  showcaseByHost,
  showcaseDomainFor,
  ShowcaseDomainInvalid,
  startShowcaseDomain,
  type ShowcaseDomainRefusal,
  type ShowcaseDomainView,
} from './domain';
export { listWorkspaceShowcases, type WorkspaceShowcaseRow, type WorkspaceShowcases } from './workspace';
