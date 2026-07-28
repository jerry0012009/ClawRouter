import test from "node:test";
import assert from "node:assert/strict";
import { parsePort } from "../src/parser.mjs";

test("parsePort accepts the valid TCP range", () => {
  assert.equal(parsePort("8402"), 8402);
});

test("parsePort rejects zero and values above 65535", () => {
  assert.throws(() => parsePort("0"), /range/);
  assert.throws(() => parsePort("70000"), /range/);
});
