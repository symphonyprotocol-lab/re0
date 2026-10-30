/**
 * The three Agent Card levels as A2A tenants (agent-first-proposal.md 7.1):
 * the platform (`''`), a user (`users/{handle}`) and a channel
 * (`channels/{slug}`). One A2A server answers all three and routes by the
 * tenant an interface declares.
 *
 * A tenant that names nothing -- an unknown handle, an unknown slug, or a
 * private or suspended channel -- resolves to null and is answered exactly
 * like a missing one: a private channel has no card and no endpoint
 * (proposal 7.1), and its existence is its owner's business.
 *
 * So is a user who has published nothing. Proposal 4.3: "没有公开频道的用户
 * 没有公开主页" -- and a card or an endpoint that answered for every handle
 * would confirm that an account exists for a guessed e-mail local part, and
 * print its OAuth display name. Such a user's tenant resolves only for that
 * user's own workspace, whose extended card lists what is theirs (7.1), and
 * names them by handle until they publish.
 */
import { channelBySlug, userByHandle, workspaceByHandle } from '@/lib/application/channels';
import { normalizeChannelSlug, PLATFORM_CHANNEL_SLUG } from '@/lib/domain/channel';
import { normalizeHandle } from '@/lib/domain/handle';

export type A2ATenant =
  | { level: 'platform'; key: '' }
  | { level: 'user'; key: string; handle: string; workspaceId: string; name: string }
  | {
      level: 'channel';
      key: string;
      slug: string;
      channelId: string;
      workspaceId: string | null;
      title: string;
      description: string | null;
      ownerHandle: string | null;
    };

export const PLATFORM_TENANT: A2ATenant = { level: 'platform', key: '' };

/** `users/alice`, `channels/rust-notes` or ''; null for anything else. */
export function parseTenantKey(raw: string): { level: 'platform' } | { level: 'user' | 'channel'; name: string } | null {
  const key = raw.trim().replace(/^\/+|\/+$/g, '');
  if (key === '') return { level: 'platform' };
  const [kind, name, ...rest] = key.split('/');
  if (!name || rest.length > 0) return null;
  if (kind === 'users') {
    const handle = normalizeHandle(name);
    return handle ? { level: 'user', name: handle } : null;
  }
  if (kind === 'channels') {
    const lowered = name.toLowerCase();
    /* The platform channel's slug is reserved from user channels, not from addressing. */
    const slug = lowered === PLATFORM_CHANNEL_SLUG ? lowered : normalizeChannelSlug(lowered);
    return slug ? { level: 'channel', name: slug } : null;
  }
  return null;
}

/**
 * The tenant a key names, as `viewerWorkspaceId` -- the calling workspace,
 * or null for an anonymous caller or a public card -- may see it.
 */
export async function resolveTenant(raw: string, viewerWorkspaceId: string | null = null): Promise<A2ATenant | null> {
  const parsed = parseTenantKey(raw);
  if (!parsed) return null;
  if (parsed.level === 'platform') return PLATFORM_TENANT;
  if (parsed.level === 'user') {
    const workspace = await workspaceByHandle(parsed.name);
    if (!workspace) return null;
    const published = (await userByHandle(workspace.handle)) !== null;
    if (!published && viewerWorkspaceId !== workspace.id) return null;
    return {
      level: 'user',
      key: `users/${workspace.handle}`,
      handle: workspace.handle,
      workspaceId: workspace.id,
      name: published ? workspace.name : workspace.handle,
    };
  }
  /* Public view only: a private channel has no card, even for its owner. */
  const channel = await channelBySlug(parsed.name, null);
  if (!channel) return null;
  return {
    level: 'channel',
    key: `channels/${channel.slug}`,
    slug: channel.slug,
    channelId: channel.id,
    workspaceId: channel.workspaceId,
    title: channel.title,
    description: channel.description,
    ownerHandle: channel.owner.handle,
  };
}

/**
 * Where a request path under `/a2a` names its tenant, and what is left of
 * it. Segments are decoded and re-split, because the SDK's REST client sends
 * a tenant as one encoded segment (`channels%2Frust-notes`) while a person
 * types the slash.
 */
export function splitTenantPath(segments: readonly string[]): { tenant: string; rest: string[] } {
  const parts = segments
    .flatMap((segment) => safeDecode(segment).split('/'))
    .filter((segment) => segment.length > 0);
  if ((parts[0] === 'users' || parts[0] === 'channels') && parts.length >= 2) {
    return { tenant: `${parts[0]}/${parts[1]}`, rest: parts.slice(2) };
  }
  return { tenant: '', rest: parts };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
