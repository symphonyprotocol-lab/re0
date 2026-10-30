/**
 * The console's access-rules page. requirement.md 5.2 访问规则.
 *
 * Owner and Admin edit, Developer and Viewer read; a draft is previewed
 * (counted) as it changes and applied as one incremental patch through
 * `patchPolicy`, so the console mints the same immutable Policy Version the
 * API does. A version affects new requests only: every request pins the
 * newest version when it starts (architecture.md 9.2), and one already in
 * flight keeps the one it pinned.
 */
import { AppError } from '@/contracts/errors';
import { workspacePolicySchema } from '@/contracts/schemas';
import {
  diffPolicy,
  normalizePolicyMode,
  policyDiffIsEmpty,
  type WorkspacePolicy,
} from '@/lib/domain/policy';
import { uuidv7 } from '@/lib/domain/id';
import type { WorkspaceRole } from '@/lib/application/assets';
import { countReachableAssets, patchPolicy, pinPolicy } from './policy-store';

/** requirement.md 5.2: Owner/Admin may change the rules; Developer reads. */
export function canManagePolicy(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

export interface WorkspacePolicyState {
  versionId: string | null;
  policy: WorkspacePolicy;
  reachable: number;
}

export async function readWorkspacePolicy(workspaceId: string): Promise<WorkspacePolicyState> {
  const pinned = await pinPolicy(workspaceId);
  return {
    versionId: pinned.versionId,
    policy: pinned.policy,
    reachable: await countReachableAssets(workspaceId, pinned.policy),
  };
}

/**
 * A draft from the browser is untrusted until the contract schema says
 * otherwise -- and its mode is made explicit here, so the count previewed and
 * the version stored enforce what the screen showed rather than what the
 * browser happened to send.
 */
function parseDraft(draft: unknown): WorkspacePolicy {
  const parsed = workspacePolicySchema.safeParse(draft);
  if (!parsed.success) throw new AppError('invalid_request', 'unrecognised policy shape');
  return normalizePolicyMode(parsed.data);
}

/** The count the console shows before the draft is saved. */
export async function previewWorkspacePolicy(input: {
  workspaceId: string;
  draft: unknown;
}): Promise<number> {
  return countReachableAssets(input.workspaceId, parseDraft(input.draft));
}

export interface ApplyWorkspacePolicyInput {
  workspaceId: string;
  role: WorkspaceRole;
  /** The version the draft was edited from, so only the edits are patched. */
  base: unknown;
  draft: unknown;
}

/**
 * Pin a new version holding the draft. The patch is the difference between
 * the draft and the version it was edited from, so two admins editing
 * different parts of the rules at once both land, and neither wipes the
 * other's work by re-sending a whole snapshot.
 */
export async function applyWorkspacePolicy(
  input: ApplyWorkspacePolicyInput,
): Promise<WorkspacePolicyState> {
  if (!canManagePolicy(input.role)) {
    throw new AppError('access_denied', 'only an owner or admin may change the access rules');
  }
  const base = parseDraft(input.base);
  const draft = parseDraft(input.draft);
  const diff = diffPolicy(base, draft);
  if (policyDiffIsEmpty(diff)) {
    return readWorkspacePolicy(input.workspaceId);
  }
  const response = await patchPolicy(input.workspaceId, diff, uuidv7());
  return {
    versionId: response.policyVersionId,
    policy: response.policy,
    reachable: response.accessibleAssetCount,
  };
}
