'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/upload';
import type { GithubRepositoryPage } from '@/lib/infra/connectors/github';
import { parseGithubRepo, repositoryUrl } from '@/lib/domain/sources';
import { useI18n } from '@/i18n/client';
import { WorkspaceLink } from '@/components/shell/workspace-link';

export function GithubRepositoryPicker({ url, accessUrl, onSelect }: { url: string; accessUrl: string; onSelect: (url: string) => void }) {
  const { t } = useI18n();
  const m = t.knowledge.addModal;
  const [request, setRequest] = useState({ page: 1 });
  const [list, setList] = useState<GithubRepositoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    void api<GithubRepositoryPage & { error?: string }>(`/api/auth/github/repositories?page=${request.page}`, { signal: controller.signal })
      .then(({ ok, data }) => {
        if (controller.signal.aborted) return;
        if (!ok || !Array.isArray(data.repositories)) {
          setError(data.error ?? 'github_repositories_unavailable');
          return;
        }
        setList((previous) => ({
          repositories: request.page === 1 ? data.repositories : [...new Set([...(previous?.repositories ?? []), ...data.repositories])],
          nextPage: data.nextPage,
        }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('github_repositories_unavailable');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [request]);

  const loadPage = (page: number) => {
    setError(null);
    setLoading(true);
    setRequest({ page });
  };

  const groups = new Map<string, string[]>();
  for (const fullName of list?.repositories ?? []) {
    const owner = fullName.split('/')[0]!;
    const group = groups.get(owner) ?? [];
    group.push(fullName);
    groups.set(owner, group);
  }
  const ref = parseGithubRepo(url);
  const selected = ref ? `${ref.owner}/${ref.name}` : '';

  return (
    <div className="field">
      <label htmlFor="github-repository">{m.githubRepositories}</label>
      <select
        id="github-repository"
        value={list?.repositories.includes(selected) ? selected : ''}
        disabled={!list?.repositories.length}
        onChange={(event) => {
          const repository = parseGithubRepo(event.target.value);
          onSelect(repository ? repositoryUrl(repository) : '');
        }}
      >
        <option value="">{m.githubChooseRepository}</option>
        {[...groups].map(([owner, repositories]) => (
          <optgroup key={owner} label={owner}>
            {repositories.map((name) => <option key={name} value={name}>{name}</option>)}
          </optgroup>
        ))}
      </select>
      <div className="flex flex-wrap gap-3">
        <a className="text-link" href={accessUrl} target="_blank" rel="noreferrer">{t.settings.connections.githubManage}</a>
        <button type="button" className="text-link" disabled={loading} onClick={() => loadPage(1)}>{m.githubRefreshRepositories}</button>
        {list?.nextPage && (
          <button type="button" className="text-link" disabled={loading} onClick={() => loadPage(list.nextPage!)}>{m.githubMoreRepositories}</button>
        )}
      </div>
      <div className="form-hint" role="status">
        {loading ? m.githubLoadingRepositories : error === 'github_not_connected' ? (
          <WorkspaceLink className="text-link" href="/settings?tab=connections">{t.settings.connections.githubReconnect}</WorkspaceLink>
        ) : error ? m.githubRepositoriesUnavailable : list?.repositories.length ? m.githubMissingRepository : m.githubNoRepositories}
      </div>
    </div>
  );
}
