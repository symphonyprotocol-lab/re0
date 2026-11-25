import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime } from '@/i18n/format';
import { appBaseUrl } from '@/lib/http/cookies';
import { keyIsLive, listApiKeys } from '@/lib/services/api-keys';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Icon } from '@/components/ui/icons';
import { CopyButton } from '@/components/files/file-actions';
import { FilesTopbar, WriterChip } from '@/components/files/files-parts';
import '@/components/knowledge/knowledge.css';
import '@/components/files/files.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.files.connect.title };
}

/**
 * `/files/connect`: how to plug each MCP client into the workspace, and the
 * keys that can reach it with the client each last connected as. Keys are
 * made and revoked in Settings → API; a secret is shown only there, once.
 */
export default async function FilesConnectPage() {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const c = t.files.connect;
  const url = `${appBaseUrl()}/api/mcp`;
  const keys = (await listApiKeys(user.id)).filter((key) => key.workspaceAccess !== 'none' && keyIsLive(key));
  const snippets = {
    claude: `claude mcp add --transport http re0 ${url} --header "Authorization: Bearer re0_sk_…"`,
    codex: `[mcp_servers.re0]\nurl = "${url}"\nbearer_token_env_var = "RE0_API_KEY"`,
    cursor: JSON.stringify({ mcpServers: { re0: { url, headers: { Authorization: 'Bearer re0_sk_…' } } } }, null, 2),
    json: JSON.stringify({ mcpServers: { re0: { type: 'http', url, headers: { Authorization: 'Bearer re0_sk_…' } } } }, null, 2),
  };
  const snippet = (label: string, code: string) => (
    <div className="ws-snip">
      <div className="ws-snip-head">
        <strong>{label}</strong>
        <CopyButton text={code} label={c.copy} className="btn ghost sm" />
      </div>
      <pre className="ws-pre">{code}</pre>
    </div>
  );
  return (
    <>
      <FilesTopbar t={t} tab="connect" crumbs={[{ label: c.title }]} />
      <main className="knowledge-ui files-ui">
        <div className="km-page">
          <div className="km-page-head">
            <div>
              <p className="eyebrow">{c.eyebrow}</p>
              <h1>{c.title}</h1>
              <p>{c.lede}</p>
            </div>
          </div>
          <section className="card ws-step">
            <span className="ws-step-n">1</span>
            <div className="ws-grow">
              <strong>{c.stepKey}</strong>
              <small>{c.stepKeyBody}</small>
            </div>
            <Link className="btn secondary sm" href="/settings?tab=api">
              <Icon name="plus" />
              {c.createKey}
            </Link>
          </section>
          <section className="card">
            <ul className="ws-keys" aria-label={c.keysTitle}>
              {keys.map((key) => (
                <li key={key.id}>
                  <strong>{key.name}</strong>
                  <span className="mono">re0_sk_…{key.tail}</span>
                  <span className="tag">{key.kind === 'workspace' ? c.workspaceKey : c.accountKey}</span>
                  <span className={`tag ${key.workspaceAccess === 'write' ? 'orange' : ''}`}>{c.access[key.workspaceAccess === 'write' ? 'write' : 'read']}</span>
                  {key.kind === 'workspace' && <span className="tag">{fill(c.root, { root: key.workspaceRoot })}</span>}
                  <span className="ws-grow" />
                  {key.lastUsedAt ? (
                    <>
                      <WriterChip t={t} writer={key.client} />
                      <small className="ws-muted">{formatDateTime(key.lastUsedAt, locale)}</small>
                    </>
                  ) : (
                    <small className="ws-muted">{c.neverUsed}</small>
                  )}
                </li>
              ))}
              {keys.length === 0 && (
                <li>
                  <span className="ws-muted">{c.noKeys}</span>
                </li>
              )}
            </ul>
          </section>
          <h2 className="ws-section-title">{c.snippetsTitle}</h2>
          <p className="ws-muted">{c.snippetsBody}</p>
          <div className="ws-connect-grid mt-3">
            {snippet(c.claude, snippets.claude)}
            {snippet(c.codex, snippets.codex)}
            {snippet(c.cursor, snippets.cursor)}
            {snippet(c.json, snippets.json)}
            <div className="ws-snip">
              <div className="ws-snip-head">
                <strong>{c.webTitle}</strong>
                <span className="tag orange">{c.webSoon}</span>
              </div>
              <p>{c.webBody}</p>
            </div>
          </div>
          <section className="card ws-try">
            <strong>{c.tryTitle}</strong>
            <ul>
              {c.try.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </div>
      </main>
    </>
  );
}
