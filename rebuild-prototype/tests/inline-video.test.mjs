import test from "node:test";
import assert from "node:assert/strict";
import { toggleInlineFullscreen } from "../inline-video.js";

const classes = () => {
  const values = new Set();
  return { add: (value) => values.add(value), remove: (value) => values.delete(value), contains: (value) => values.has(value) };
};
const documentStub = () => ({
  fullscreenElement: null,
  body: { classList: classes() },
  async exitFullscreen() { this.fullscreenElement = null; },
});
test("fullscreen expands and restores the same player without resetting playback position", async () => {
  const doc = documentStub();
  const player = {
    progress: 7.4,
    classList: classes(),
    async requestFullscreen() { doc.fullscreenElement = this; },
  };
  assert.equal(await toggleInlineFullscreen(player, doc), true);
  assert.equal(doc.fullscreenElement, player);
  assert.equal(player.progress, 7.4);
  assert.equal(await toggleInlineFullscreen(player, doc), false);
  assert.equal(doc.fullscreenElement, null);
  assert.equal(doc.body.classList.contains("has-dot-fullscreen"), false);
  assert.equal(player.progress, 7.4);
});
test("embedded browsers still expand and exit when native fullscreen is denied or unavailable", async () => {
  for (const requestFullscreen of [undefined, async () => { throw new Error("Fullscreen denied"); }]) {
    const doc = documentStub(), player = { classList: classes(), requestFullscreen };
    assert.equal(await toggleInlineFullscreen(player, doc), true);
    assert.equal(player.classList.contains("is-page-fullscreen"), true);
    assert.equal(doc.body.classList.contains("has-dot-fullscreen"), true);
    assert.equal(await toggleInlineFullscreen(player, doc), false);
    assert.equal(player.classList.contains("is-page-fullscreen"), false);
  }
  assert.equal(await toggleInlineFullscreen(null, documentStub()), false);
});
test("a delayed native request does not reopen fullscreen after the user has exited", async () => {
  const doc = documentStub();
  let complete;
  const player = { classList: classes(), requestFullscreen: () => new Promise(resolve => { complete = resolve; }) };
  await toggleInlineFullscreen(player, doc);
  await toggleInlineFullscreen(player, doc);
  doc.fullscreenElement = player;
  complete();
  await Promise.resolve();
  assert.equal(doc.fullscreenElement, null);
  assert.equal(player.classList.contains("is-page-fullscreen"), false);
});
