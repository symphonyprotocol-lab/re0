import test from "node:test";
import assert from "node:assert/strict";
import {
  hasVideoIntroduction,
  discoveryVideoStyle,
  hasPublicVideoIntroduction,
  publicVideoSource,
} from "../discovery-video.js";

test("only generated owned videos get a play button; external sample defaults remain available", () => {
  assert.equal(hasVideoIntroduction({ owner: "me" }), false);
  assert.equal(
    hasVideoIntroduction({ owner: "me", video: { generated: false } }),
    false,
  );
  assert.equal(
    hasVideoIntroduction({ owner: "me", video: { generated: true } }),
    true,
  );
  assert.equal(hasVideoIntroduction({ owner: "other" }), true);
  assert.equal(
    hasVideoIntroduction({ owner: "other", video: { generated: false } }),
    false,
  );
  assert.equal(hasVideoIntroduction(null), false);
});
test("the built-in assistant restores its public introduction without publishing or overwriting authoring drafts", () => {
  const stock = {id:"mine",slug:"re0-product",owner:"me",public:true,video:{generated:false,scenes:[{name:"PRIVATE_DRAFT"}],revision:3}};
  const before = structuredClone(stock);
  assert.equal(hasVideoIntroduction(stock),false);
  assert.equal(hasPublicVideoIntroduction(stock),true);
  const source = publicVideoSource(stock);
  assert.notEqual(source,stock);
  assert.equal(source.video,undefined);
  assert.deepEqual(stock,before);
  assert.equal(hasPublicVideoIntroduction({...stock,id:"custom",slug:"custom"}),false);
  assert.equal(hasPublicVideoIntroduction(null),false);
  const published = {...stock,video:{generated:true,scenes:[{name:"Published video"}]}};
  assert.equal(publicVideoSource(published),published);
});
test("cover style uses the saved video template and a valid accent", () => {
  assert.deepEqual(
    discoveryVideoStyle({
      video: { template: "blueprint", accent: "#123abc" },
    }),
    { template: "blueprint", accent: "#123abc" },
  );
  assert.deepEqual(
    discoveryVideoStyle({ video: { template: "unknown", accent: "invalid" } }),
    { template: "editorial", accent: "#127ee3" },
  );
});
