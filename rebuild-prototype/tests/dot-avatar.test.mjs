import test from "node:test";
import assert from "node:assert/strict";
import { DOT_MARK, dotAvatarValue, renderDotAvatar } from "../dot-avatar.js";
const esc = (value) => String(value).replaceAll('"', "&quot;");
test("Ree avatars use the knowledge-node mark for all legacy defaults", () => {
  const html = renderDotAvatar({ icon: "dot", color: "sage" }, { esc });
  assert.match(html, /dot-avatar sage/);
  assert.ok(html.includes(DOT_MARK));
  assert.doesNotMatch(html, /<img/);
  assert.match(renderDotAvatar({ icon: "book" }, { esc, small: true }), / sm/);
});
test("custom Ree avatars accept supported local image data and reject active or oversized URLs", () => {
  const image = "data:image/webp;base64,YWJj";
  assert.equal(dotAvatarValue(image), image);
  assert.match(renderDotAvatar({ avatar: image }, { esc }), /<img/);
  for (const value of [
    null,
    "https://example.com/photo.jpg",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,YWJj",
    "data:image/png;base64," + "a".repeat(700000),
  ])
    assert.equal(dotAvatarValue(value), "");
  assert.ok(renderDotAvatar({ avatar: "invalid" }, { esc }).includes(DOT_MARK));
});
