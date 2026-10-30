/**
 * The creator kinds: articles, audio episodes and their files
 * (agent-first-proposal.md 6.5, 6.6). Pages, actions, routes and the drain
 * enter through this module; Q&A lives with the questions it answers
 * (lib/application/questions).
 */
export {
  createEditorialAsset,
  ownedEditorialAsset,
  publishDueDrafts,
  publishEditorial,
  readEditorialDraft,
  saveEditorialDraft,
  unscheduleEditorial,
  type CreateEditorialInput,
  type EditorActor,
  type EditorialAsset,
  type EditorialDraft,
  type PublishResult,
} from './assets';
export { confirmMediaUpload, mediaUrlFor, prepareMediaUpload, setImageCaption, type PreparedMedia } from './media';
export { editorialReading, type EditorialReading } from './reading';
export { notifyFirstPublication } from './notify';
