/**
 * Channels: the one way an asset is shown to anyone but its owner
 * (agent-first-proposal.md 6). Route Handlers, pages and the A2A server enter
 * through this module.
 */
export { exposure, listedInPublicChannel, readableBy, sharedWithEveryone, subscribedPaid } from './visibility';
export { channelsOfAssets, isPublicChannel, type ChannelRef } from './membership';
export {
  createChannel,
  deleteChannel,
  editChannel,
  listWorkspaceChannels,
  moveAsset,
  pinAsset,
  type CreateChannelInput,
  type EditChannelInput,
  type MoveAssetInput,
  type MoveAssetResult,
  type WorkspaceChannel,
} from './manage';
export {
  channelBySlug,
  channelStream,
  listChannelDirectory,
  ownedChannelView,
  publicCardSubjects,
  userByHandle,
  workspaceByHandle,
  DIRECTORY_PAGE_SIZE,
  type ChannelOwner,
  type ChannelStreamItem,
  type ChannelView,
  type DirectoryEntry,
  type UserView,
} from './directory';
export { readChannelProfile, refreshChannelProfile, type ChannelProfile } from './profile';
export { recordChannelVisit, type ChannelVisitor } from './visits';
export { findChannels, FIND_CHANNELS_DEFAULT, FIND_CHANNELS_MAX, type FoundChannel } from './find';
