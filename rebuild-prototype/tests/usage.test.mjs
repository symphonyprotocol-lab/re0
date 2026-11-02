import test from "node:test";
import assert from "node:assert/strict";
import { creditUsage } from "../usage.js";
test("monthly Plan usage excludes Pack, earned, and welcome credits", () => {
  const result = creditUsage({
    plan: true,
    planCredits: 68120,
    packCredits: 100000,
    earnedCredits: 528000,
    welcomeCredits: 0,
  });
  assert.equal(result.used, 31880);
  assert.equal(result.allowance, 100000);
  assert.equal(result.remaining, 68120);
  assert.equal(result.total, 696120);
  assert.equal(result.percent, 31.88);
});
test("cancelled renewal retains active membership and current allowance", () => {
  const result = creditUsage({
    plan: true,
    cancelled: true,
    planCredits: 50000,
  });
  assert.equal(result.active, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.allowance, 100000);
});
test("free accounts have no recurring monthly allowance but retain spendable credits", () => {
  const result = creditUsage({
    plan: false,
    welcomeCredits: 2000,
    packCredits: 1000,
  });
  assert.equal(result.allowance, 0);
  assert.equal(result.used, 0);
  assert.equal(result.total, 3000);
  assert.equal(result.percent, 0);
});
test("fully used Plan does not imply expired membership", () => {
  const result = creditUsage({ plan: true, planCredits: 0 });
  assert.equal(result.used, 100000);
  assert.equal(result.percent, 100);
  assert.equal(result.active, true);
});
