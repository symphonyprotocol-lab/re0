import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceSummary,
  workspaceSummary,
  creatorPayoutStatus,
} from "../workspace.js";

test("creator totals include only owned active Rees and exclude trashed sources", () => {
  const state = {
    dots: [
      {
        id: "mine",
        owner: "me",
        public: true,
        answers: 7,
        knowledge: [{ status: "ready" }, { status: "failed" }],
        knowledgeTrash: [{ status: "ready" }],
      },
      { id: "private", owner: "me", public: false, answers: 3, knowledge: [] },
      {
        id: "other",
        owner: "someone",
        public: true,
        answers: 100,
        knowledge: [{ status: "ready" }],
      },
    ],
    archivedDots: [
      { owner: "me", answers: 80, knowledge: [{ status: "ready" }] },
    ],
    earnedCredits: 528000,
    planCredits: 100000,
    packCredits: 100000,
  };
  const before = JSON.stringify(state),
    result = workspaceSummary(state);
  assert.equal(result.dots.length, 2);
  assert.equal(result.sources.total, 2);
  assert.equal(result.answers, 10);
  assert.equal(result.publicDots, 1);
  assert.equal(result.privateDots, 1);
  assert.equal(result.earned, 528000);
  assert.equal(JSON.stringify(state), before);
});
test("source health states are disjoint and disabled sources are not answer-ready", () => {
  const counts = sourceSummary([
    { status: "ready" },
    { status: "ready", enabled: false },
    { status: "failed" },
    { status: "pending" },
    { status: "processing" },
    { status: "failed", enabled: false },
  ]);
  assert.deepEqual(counts, {
    total: 6,
    ready: 1,
    processing: 2,
    failed: 1,
    paused: 2,
  });
  assert.equal(
    counts.total,
    counts.ready + counts.processing + counts.failed + counts.paused,
  );
});
test("empty accounts have zero source and answer metrics and no fabricated income", () => {
  const data = workspaceSummary({
    dots: [],
    planCredits: 100000,
    packCredits: 100000,
  });
  assert.equal(data.sources.total, 0);
  assert.equal(data.answers, 0);
  assert.equal(data.earned, 0);
  assert.equal(data.held, 0);
});
test("held earnings count pending and approved requests, excluding settled requests", () => {
  const state = {
    payouts: [
      { status: "pending", credits: 500000 },
      { status: "approved", credits: 600000 },
      { status: "paid", credits: 700000 },
      { status: "failed", credits: 800000 },
      { status: "rejected", credits: 900000 },
    ],
  };
  assert.equal(workspaceSummary(state).held, 1100000);
  assert.equal(creatorPayoutStatus(state), "review");
  assert.equal(
    creatorPayoutStatus({ payouts: [{ status: "approved", credits: 500000 }] }),
    "payment",
  );
});
test("overview payout guidance follows identity, PayPal, hold and minimum gates", () => {
  assert.equal(
    creatorPayoutStatus({ kyc: "pending", earnedCredits: 528000 }),
    "identity-pending",
  );
  for (const kyc of ["none", "rejected", "reset"])
    assert.equal(creatorPayoutStatus({ kyc }), "identity-required");
  assert.equal(creatorPayoutStatus({ kyc: "verified" }), "paypal");
  const state = {
    kyc: "verified",
    paypal: "demo@example.com",
    earnedCredits: 500000,
    paypalChanged: 1000,
  };
  assert.equal(creatorPayoutStatus(state, 1000 + 6 * 86400000), "hold");
  assert.equal(creatorPayoutStatus(state, 1000 + 7 * 86400000), "eligible");
  assert.equal(
    creatorPayoutStatus({ ...state, paypalChanged: 0, earnedCredits: 499999 }),
    "threshold",
  );
});
test("moderated Rees are not counted as publicly available", () => {
  const data = workspaceSummary({
    dots: [{ owner: "me", public: true, moderated: true, answers: 0 }],
  });
  assert.equal(data.publicDots, 0);
  assert.equal(data.privateDots, 1);
});
