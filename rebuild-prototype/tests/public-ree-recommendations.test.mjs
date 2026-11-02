import test from "node:test";
import assert from "node:assert/strict";
import { reeAuthorKey, selectPublicReeRecommendations } from "../public-ree-recommendations.js";

const current = { id: "current", slug: "current", owner: "Creator", ownerId: "author-1", public: true, category: "technology", tags: ["Python"], name: "Python 自动化笔记", enName: "Python automation", description: "Python 脚本和自动化实践。", answers: 50 };
const row = (id, changes = {}) => ({ ...current, id, slug: id, ...changes });
test("related Rees prioritize matching topics over broad categories and never inspect private knowledge", () => {
  const catalog = [row("category", { name: "React components", enName: "React components", tags: ["React"], answers: 9000 }), row("topic", { answers: 1 }), row("unrelated", { category: "life", tags: ["旅行"], name: "城市旅行", enName: "City travel", description: "旅行线路" })];
  Object.defineProperty(catalog[0], "knowledge", { get() { throw new Error("Recommendations must use public metadata only"); } });
  assert.deepEqual(selectPublicReeRecommendations(current, catalog).related.items.map(r => r.id), ["topic", "category"]);
});
test("current, private, moderated and duplicate identities stay out of both recommendation groups", () => {
  const catalog = [current, row("self-slug", { slug: current.slug }), row("private", { public: false }), row("moderated", { moderated: true }), row("visible"), row("visible"), row("duplicate-slug", { slug: "visible" }), row("hidden-wins", { public: false }), row("hidden-wins")];
  const before = structuredClone(catalog);
  const result = selectPublicReeRecommendations(current, catalog);
  for (const kind of ["related", "author"]) assert.deepEqual(result[kind].items.map(r => r.id), ["visible"]);
  assert.deepEqual(catalog, before);
});
test("author lists use account ownership rather than equal display names and exclude unknown authors", () => {
  const catalog = [row("same"), row("same-name", { ownerId: "author-2" }), row("other-topic", { category: "life", tags: [], name: "旅行", enName: "Travel", answers: 100 })];
  assert.deepEqual(selectPublicReeRecommendations(current, catalog).author.items.map(r => r.id), ["other-topic", "same"]);
  assert.equal(selectPublicReeRecommendations({ ...current, owner: undefined, ownerId: undefined }, catalog).author.total, 0);
  assert.equal(reeAuthorKey({ owner: "me" }), reeAuthorKey({ ownerId: "me", owner: "New display name" }));
  assert.equal(reeAuthorKey({ ownerEmail: "A@EXAMPLE.COM" }), reeAuthorKey({ ownerEmail: "a@example.com" }));
  assert.notEqual(reeAuthorKey(current), reeAuthorKey({ owner: current.owner }));
});
test("large catalogs paginate independently, clamp stale pages and reflect live visibility without mutations", () => {
  const catalog = Array.from({ length: 600 }, (_, i) => row("ree-" + i, { answers: i }));
  const before = structuredClone(catalog), visited = [];
  for (let page = 1; page <= 150; page++) {
    const result = selectPublicReeRecommendations(current, catalog, { related: 1, author: page });
    assert.equal(result.author.items.length, 4);
    assert.equal(result.related.page, 1);
    assert.equal(result.related.total, 10);
    visited.push(...result.author.items.map(r => r.id));
  }
  assert.equal(new Set(visited).size, 600);
  const related = [1, 2, 3].flatMap(page => selectPublicReeRecommendations(current, catalog, { related: page }).related.items.map(r => r.id));
  assert.deepEqual(related, Array.from({ length: 10 }, (_, i) => "ree-" + (599 - i)));
  const lastRelated = selectPublicReeRecommendations(current, catalog, { related: 900 }).related;
  assert.equal(lastRelated.page, 3);
  assert.equal(lastRelated.items.length, 2);
  assert.deepEqual(catalog, before);
  assert.equal(selectPublicReeRecommendations(current, catalog, { author: 900 }).author.page, 150);
  catalog[599].public = false;
  const updated = selectPublicReeRecommendations(current, catalog);
  assert.equal(updated.related.total, 10);
  assert.equal(updated.author.total, 599);
  assert.equal(updated.author.items[0].id, "ree-598");
  assert.equal(selectPublicReeRecommendations(current, []).related.pages, 1);
});
