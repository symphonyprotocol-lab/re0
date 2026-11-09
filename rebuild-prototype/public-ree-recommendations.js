import { dotCategory } from "./dot-classification.js";

export const PUBLIC_REE_PAGE_SIZE = 4;
export const PUBLIC_REE_RELATED_LIMIT = 10;
const normalize = value => String(value || "").normalize("NFKC").toLowerCase().trim();
const genericTokens = new Set(["the", "and", "for", "with", "your", "ree", "rees", "notes", "guide", "handbook", "knowledge", "practice", "methods", "知识", "笔记", "手册", "指南", "实践", "方法", "整理", "档案", "伙伴", "内容", "案例", "经验", "相关", "问题"]);

// Explicit account IDs take precedence over legacy display-name ownership.
export function reeAuthorKey(dot) {
  if (dot.owner === "me" || dot.ownerId === "me") return "account:me";
  if (dot.ownerId) return "account:" + dot.ownerId;
  if (dot.ownerEmail) return "email:" + normalize(dot.ownerEmail);
  return dot.owner ? "legacy:" + dot.owner : null;
}
function tokens(text) {
  const value = normalize(text), result = new Set(value.match(/[a-z][a-z0-9+#-]{1,}/g) || []);
  for (const phrase of value.match(/\p{Script=Han}{2,}/gu) || [])
    for (let i = 0; i < phrase.length - 1; i++) result.add(phrase.slice(i, i + 2));
  return new Set([...result].filter(token => !genericTokens.has(token)));
}
function overlap(a, b) {
  const shared = [...a].filter(value => b.has(value)).length;
  return shared ? shared / (a.size + b.size - shared) : 0;
}
function metadata(dot) {
  return {
    category: dotCategory(dot),
    tags: new Set((dot.tags || []).map(normalize).filter(Boolean)),
    title: tokens([dot.name, dot.enName].filter(Boolean).join(" ")),
    description: tokens([dot.description, dot.enDescription].filter(Boolean).join(" ")),
  };
}
function similarity(a, b) {
  const tags = [...a.tags].filter(tag => b.tags.has(tag)).length;
  const category = a.category !== "other" && a.category === b.category;
  const title = overlap(a.title, b.title);
  if (!tags && !category && !title) return 0;
  return tags * 3 + (category ? 2 : 0) + title * 8 + overlap(a.description, b.description);
}
const answers = dot => Number.isFinite(Number(dot.answers)) ? Math.max(0, Number(dot.answers)) : 0;
const byAnswers = (a, b) => answers(b) - answers(a) || String(a.id).localeCompare(String(b.id), "en", { numeric: true });
function paginate(rows, requested) {
  const pages = Math.max(1, Math.ceil(rows.length / PUBLIC_REE_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(requested) || 1)));
  return { items: rows.slice((page - 1) * PUBLIC_REE_PAGE_SIZE, page * PUBLIC_REE_PAGE_SIZE), total: rows.length, page, pages };
}
export function selectPublicReeRecommendations(dot, catalog, view = {}) {
  const ids = new Set(), slugs = new Set();
  const visible = catalog.filter(candidate => {
    if (!candidate?.id || !candidate.slug || ids.has(candidate.id) || slugs.has(candidate.slug)) return false;
    ids.add(candidate.id); slugs.add(candidate.slug);
    return candidate.public && !candidate.moderated && candidate.id !== dot.id && candidate.slug !== dot.slug;
  });
  const current = metadata(dot), author = reeAuthorKey(dot);
  const related = visible.map(candidate => ({ dot: candidate, score: similarity(current, metadata(candidate)) }))
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score || byAnswers(a.dot, b.dot)).slice(0, PUBLIC_REE_RELATED_LIMIT).map(row => row.dot);
  const others = author ? visible.filter(candidate => reeAuthorKey(candidate) === author).sort(byAnswers) : [];
  return { related: paginate(related, view.related), author: paginate(others, view.author) };
}
