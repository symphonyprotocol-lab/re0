import { AppError } from '@/contracts/errors';

/** ingestion use cases. Route Handlers and MCP tools may only enter through this layer. */
export function notImplemented(name: string): never {
  throw new AppError('not_implemented', `${name} is not implemented yet`);
}

export { buildVersion, type BuildOutcome } from './build-version';
export { publishVersion, type PublishResult } from './publish-version';
export { rebuildProfile, rebuildStaleProfiles } from './rebuild-profile';
export { purgeLibrary, type PurgeOutcome } from './purge-library';
export { purgeAbandonedUploads, type PurgeUploadsOutcome } from './purge-uploads';
export {
  refreshSchedule,
  scheduleDueRefreshes,
  type ScheduledRefresh,
  type ScheduledSource,
} from './schedule-refreshes';
export {
  drainOperations,
  runOperation,
  MAX_ATTEMPTS,
  type OperationOutcome,
} from './run-operation';
export {
  defaultDependencies,
  isIngestionConfigured,
  memoryObjectStore,
  type IngestionDependencies,
} from './dependencies';
