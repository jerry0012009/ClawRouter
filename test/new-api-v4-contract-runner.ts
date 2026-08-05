import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolvedRoutingUtilityPolicy,
  verifyTrustedIdentity,
} from "../src/alpha/trusted-identity.js";

type ContractRequest = {
  body: string;
  headers: Record<string, string | string[]>;
};

type ContractInput = {
  secret: string;
  scoped: ContractRequest;
  emptyScope: ContractRequest;
};

function incomingHeaders(headers: ContractRequest["headers"]): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      assert.ok(!Array.isArray(value) || value.length === 1, `repeated header ${name}`);
      return [name.toLowerCase(), Array.isArray(value) ? String(value[0]) : value];
    }),
  );
}

function verify(request: ContractRequest, secret: string) {
  return verifyTrustedIdentity(incomingHeaders(request.headers), Buffer.from(request.body), {
    sharedSecret: secret,
  });
}

const input = JSON.parse(readFileSync(0, "utf8")) as ContractInput;
const scoped = verify(input.scoped, input.secret);
assert.deepEqual(scoped.allowedCandidateIds, ["gpt-5.6-luna", "gpt-5.6-luna@max"]);
assert.deepEqual(scoped.candidatePreferenceScores, { "gpt-5.6-luna@max": 150 });

const allowedTampered = structuredClone(input.scoped);
allowedTampered.headers["X-Acu-Allowed-Candidate-Ids"] = '["gpt-5.6-luna-2","gpt-5.6-luna@max"]';
assert.throws(() => verify(allowedTampered, input.secret), /signature mismatch/);

const preferenceTampered = structuredClone(input.scoped);
preferenceTampered.headers["X-Acu-Candidate-Preference-Scores"] = '{"gpt-5.6-luna@max":160}';
assert.throws(() => verify(preferenceTampered, input.secret), /signature mismatch/);

const empty = verify(input.emptyScope, input.secret);
assert.deepEqual(empty.allowedCandidateIds, []);
assert.deepEqual(empty.candidatePreferenceScores, {});
const emptyPolicy = resolvedRoutingUtilityPolicy(empty);
assert.deepEqual(emptyPolicy.allowedCandidateIds, []);
assert.deepEqual(emptyPolicy.candidatePreferenceScores, {});
