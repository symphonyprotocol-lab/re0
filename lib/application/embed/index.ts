/** Website widget use cases. Route Handlers and server actions enter through this layer. */
export {
  createSiteKey,
  listSiteKeys,
  revokeSiteKey,
  SITE_KEYS_PER_LIBRARY,
  SiteKeyInvalid,
  updateSiteKey,
  type CreateSiteKeyInput,
  type SiteKeyRefusal,
  type SiteKeySettingsInput,
  type SiteKeyView,
  type UpdateSiteKeyInput,
} from './site-keys';
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
