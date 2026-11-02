import test from "node:test";
import assert from "node:assert/strict";
import {
  DOT_CATEGORIES,
  dotCategory,
  normalizedTag,
  classificationValue,
  createDotClassification,
} from "../dot-classification.js";
test("legacy categories are inferred without changing their tags or overriding an explicit choice", () => {
  const dot = { tags: ["产品设计", "AI 应用"] };
  assert.equal(dotCategory(dot), "design");
  assert.equal(dotCategory({ ...dot, category: "technology" }), "technology");
  assert.equal(dotCategory({ tags: ["个人成长"] }), "life");
  assert.equal(dotCategory({ tags: ["定制知识"] }), "other");
  assert.deepEqual(dot.tags, ["产品设计", "AI 应用"]);
});
test("custom tags normalize whitespace and fullwidth characters and deduplicate case-insensitively", () => {
  assert.equal(normalizedTag("  Ｒｅａｃｔ  学习 "), "React 学习");
  assert.deepEqual(
    classificationValue("technology", ["React", "react", "我的知识", "  "]),
    { category: "technology", tags: ["React", "我的知识"] },
  );
});
test("category, tag count and Unicode length validation prevent invalid submissions", () => {
  assert.equal(classificationValue("unknown", []).error, "category");
  assert.equal(
    classificationValue("design", ["一", "二", "三", "四"]).error,
    "limit",
  );
  assert.equal(
    classificationValue("design", ["字".repeat(21)]).error,
    "length",
  );
  assert.equal(classificationValue("design", ["😀".repeat(20)]).tags.length, 1);
  assert.equal(classificationValue("other", []).error, undefined);
});
test("all primary categories have stable unique identifiers", () => {
  assert.equal(
    DOT_CATEGORIES.length,
    new Set(DOT_CATEGORIES.map((c) => c.id)).size,
  );
  assert.equal(DOT_CATEGORIES.length, 7);
});
test("the editor preserves legacy custom tags and escapes them without mutating the Ree", () => {
  globalThis.document = { addEventListener() {} };
  const esc = (value) =>
    String(value)
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const api = createDotClassification({ t: (zh) => zh, I: () => "", esc });
  const dot = { tags: ["AI 应用", "<custom>"] };
  const html = api.editor(dot);
  assert.match(html, /name="category" required/);
  assert.match(html, /value="technology" selected/);
  assert.match(html, /&lt;custom&gt;/);
  assert.doesNotMatch(html, /<custom>/);
  assert.deepEqual(dot.tags, ["AI 应用", "<custom>"]);
  assert.match(api.editor(), /value="" selected disabled/);
});
