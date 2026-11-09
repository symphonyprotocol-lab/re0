import test from "node:test";
import assert from "node:assert/strict";
import {
  avatarInitials,
  validateAvatarFile,
  avatarCrop,
  demoLoginIdentity,
} from "../profile.js";
test("default avatar derives initials from Latin and Chinese names", () => {
  assert.equal(avatarInitials("Yu Zhao"), "YZ");
  assert.equal(avatarInitials("林舟"), "林舟");
  assert.equal(avatarInitials(""), "YZ");
});
test("avatar uploads only accept supported images within five megabytes", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"])
    assert.equal(validateAvatarFile({ type, size: 1024 }), null);
  assert.equal(
    validateAvatarFile({ type: "image/svg+xml", size: 500 }),
    "type",
  );
  assert.equal(validateAvatarFile({ type: "image/png", size: 0 }), "size");
  assert.equal(
    validateAvatarFile({ type: "image/png", size: 5 * 1024 * 1024 + 1 }),
    "size",
  );
});
test("wide and tall crops fill the avatar without exposing empty edges", () => {
  for (const [w, h] of [
    [1000, 500],
    [500, 1000],
    [300, 300],
  ]) {
    const crop = avatarCrop(w, h, 1, 99999, -99999);
    assert.ok(crop.left <= 0 && crop.top <= 0);
    assert.ok(crop.left + crop.width >= 512);
    assert.ok(crop.top + crop.height >= 512);
  }
});
test("zoom stays within bounds and cropping stays square at the output size", () => {
  assert.equal(avatarCrop(512, 512, 0).width, 512);
  assert.equal(avatarCrop(512, 512, 20).width, 1536);
});
test("Google and GitHub sign-ins record identity independently of repository authorization", () => {
  const google = demoLoginIdentity("Google", "Yu Zhao");
  const github = demoLoginIdentity("GitHub", "Yu Zhao");
  assert.equal(google.provider, "google");
  assert.equal(google.email, "yu@example.com");
  assert.equal(google.handle, null);
  assert.equal(github.provider, "github");
  assert.equal(github.handle, "yuzhao");
  assert.equal(github.demo, true);
  assert.equal(demoLoginIdentity("unknown", "Yu Zhao"), null);
});
