import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.mjs";

test("add combines positive integers", () => {
  assert.equal(add(2, 3), 5);
});
