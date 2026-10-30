/** Website widget use cases. Route Handlers and server actions enter through this layer. */
export {
  countWorkspaceSiteKeys,
  createSiteKey,
  listSiteKeys,
  revokeSiteKey,
  SITE_KEYS_PER_ASSET,
  siteKeyEntitlement,
  SiteKeyInvalid,
  SiteKeyLimit,
  updateSiteKey,
  type CreateSiteKeyInput,
  type SiteKeyRefusal,
  type SiteKeySettingsInput,
  type SiteKeyView,
  type UpdateSiteKeyInput,
} from './site-keys';
export {
  deleteFaqEntry,
  FAQ_GROUPING,
  FaqInvalid,
  listFaqEntries,
  listFaqGroups,
  resetFaqGroupCache,
  saveFaqEntry,
  type FaqChangeResult,
  type FaqEntryView,
  type FaqGroupView,
  type SaveFaqEntryInput,
} from './faq';
export {
  EXCHANGE_PAGE_SIZE,
  listWidgetExchanges,
  noteWidgetExchange,
  recordWidgetExchange,
  widgetExchangeStats,
  type WidgetExchangeStats,
  type WidgetExchangeView,
  type WidgetOutcome,
} from './exchanges';
export {
  listWorkspaceWidgetSites,
  noteWidgetOrigin,
  recordWidgetOrigin,
  type WidgetSighting,
  type WidgetSiteKey,
  type WidgetSiteOrigin,
} from './origins';
export {
  admitWidgetQuestion,
  requireParentOrigin,
  resolveSiteKey,
  widgetCaller,
  WIDGET_VISITOR_RULE,
  type SiteKeyPrincipal,
  type WidgetAllowance,
} from './resolve';
