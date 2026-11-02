import test from "node:test";
import assert from "node:assert/strict";
import {
  decideKyc,
  expireKycFiles,
  activePayout,
  recordPayoutResult,
  normalizeManualKyc,
} from "../manual-kyc.js";
const pending = () => ({
  id: "new",
  user: "me",
  status: "pending",
  declared: true,
  document: { demo: true },
  selfie: { demo: true },
  expires: "2030-12-31",
});
test("manual KYC requires a complete current pending submission and records the reviewer", () => {
  const k = pending();
  decideKyc([k], "new", "verified", "Matched", "admin", "2026-10-31T12:00:00Z");
  assert.equal(k.status, "verified");
  assert.equal(k.reviewer, "admin");
  assert.throws(() => decideKyc([k], "new", "verified", "", "admin"));
  const expired = { ...pending(), expires: "2020-01-01" };
  assert.throws(() => decideKyc([expired], "new", "verified", "", "admin"));
  const missing = { ...pending(), selfie: null };
  assert.throws(() => decideKyc([missing], "new", "verified", "", "admin"));
});
test("rejection needs a reason and an older pending submission cannot override a reset", () => {
  const k = pending();
  assert.throws(() => decideKyc([k], "new", "rejected", " ", "admin"));
  decideKyc([k], "new", "rejected", "Unclear image", "admin");
  assert.equal(k.reason, "Unclear image");
  const old = pending();
  assert.throws(() =>
    decideKyc(
      [{ id: "reset", user: "me", status: "reset" }, old],
      "new",
      "verified",
      "",
      "admin",
    ),
  );
});
test("images expire exactly 30 days after approval, retaining necessary metadata", () => {
  const k = {
    ...pending(),
    status: "verified",
    decided: "2026-10-01T12:00:00Z",
    last4: "2048",
    reviewer: "admin",
  };
  assert.equal(expireKycFiles(k, Date.parse("2026-10-31T11:59:59Z")), false);
  assert.equal(expireKycFiles(k, Date.parse("2026-10-31T12:00:00Z")), true);
  assert.equal(k.document, null);
  assert.equal(k.selfie, null);
  assert.equal(k.last4, "2048");
  assert.equal(k.reviewer, "admin");
  assert.equal(expireKycFiles(k), false);
  assert.equal(expireKycFiles({ ...pending(), decided: "2020-01-01" }), false);
  assert.equal(expireKycFiles({ ...pending(), status: "verified", decided: "—" }), false);
});
test("legacy fixture upgrade preserves personal records and unrelated account data", () => {
  const custom = {
    id: "custom",
    provider: "Persona",
    user: "me",
    status: "verified",
    decided: "2026-10-31",
    tax: "W-8BEN",
  };
  const state = {
    earnedCredits: 528000,
    console: {
      users: [{ id: "u-mia", name: "Mia", kyc: "processing" }],
      kyc: [
        custom,
        {
          id: "kyc-mia",
          provider: "Persona",
          user: "u-mia",
          status: "processing",
        },
      ],
    },
  };
  normalizeManualKyc(state);
  assert.equal(custom.provider, "Persona");
  assert.equal(state.earnedCredits, 528000);
  assert.equal(state.console.kyc[1].status, "pending");
  assert.equal(state.console.kyc[1].provider, "manual");
});
test("approved payouts remain active and paid requires actual transfer details", () => {
  assert.equal(activePayout({ status: "pending" }), true);
  assert.equal(activePayout({ status: "approved" }), true);
  assert.equal(activePayout({ status: "paid" }), false);
  const p = { status: "approved", credits: 528000 };
  assert.throws(() => recordPayoutResult(p, "paid", { actual: 51.8 }));
  assert.throws(() =>
    recordPayoutResult(p, "paid", { actual: 99, transferId: "DEMO" }),
  );
  assert.throws(() =>
    recordPayoutResult(p, "paid", { actual: 51.801, transferId: "DEMO" }),
  );
  assert.equal(
    recordPayoutResult(p, "paid", {
      actual: 51.8,
      transferId: "DEMO",
      actor: "admin",
    }),
    false,
  );
  assert.equal(p.fee, 1);
  assert.equal(p.actual, 51.8);
  assert.equal(p.paidBy, "admin");
  assert.throws(() => recordPayoutResult(p, "failed", { reason: "failed" }));
});
test("failed payout allows a single release only after approval and requires a reason", () => {
  const p = { status: "approved", credits: 500000 };
  assert.throws(() => recordPayoutResult(p, "failed", { reason: "" }));
  assert.equal(
    recordPayoutResult(p, "failed", {
      reason: "Transfer returned",
      actor: "admin",
    }),
    true,
  );
  assert.throws(() =>
    recordPayoutResult(p, "failed", { reason: "Transfer returned" }),
  );
  assert.throws(() =>
    recordPayoutResult({ status: "pending" }, "paid", {
      actual: 49,
      transferId: "DEMO",
    }),
  );
});
