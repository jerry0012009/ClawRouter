import { describe, expect, it } from "vitest";
import {
  bodySha256,
  resolvedRoutingUtilityPolicy,
  trustedIdentityHeaders,
  verifyTrustedIdentity,
  type TrustedNewApiIdentity,
} from "../src/alpha/trusted-identity.js";
import { DEFAULT_ROUTING_UTILITY_POLICY } from "../src/alpha/routing-utility-v2.js";

const secret = "trusted-identity-v3-test-secret";
const body = Buffer.from('{"model":"acu-auto"}');

function identity(): TrustedNewApiIdentity {
  return {
    newapiUserId: "3",
    newapiTokenId: "3",
    newapiLogId: "log-v3",
    requestId: "request-v3",
    clientVersion: "test",
    routingPolicy: "all_routing_eligible",
    allowedModelIds: [],
    allowedProfileIds: [],
    routingPolicyVersion: "acu-user-policy-v2-0123456789abcdef",
    routingPreference: "balanced",
    qualityBias: 17,
    supplyStrategy: "balanced",
    supplyWeights: { cost: 40, speed: 25, reliability: 35 },
    acuHighBiasOffset: 40,
    modelCostLogScale: 2.5,
    profileCostLogScale: 2.5,
    profileSpeedLogScale: 2.5,
    latencyPolicy: DEFAULT_ROUTING_UTILITY_POLICY.latency,
    reliabilityPolicy: DEFAULT_ROUTING_UTILITY_POLICY.reliability,
    workPhaseBiasOffsets: DEFAULT_ROUTING_UTILITY_POLICY.workPhaseBiasOffsets,
    routingUtilityVersion: "acu-routing-utility-v1-0123456789abcdef",
    formulaMode: "shadow",
    identityVersion: "v3",
    timestamp: new Date().toISOString(),
    bodySha256: bodySha256(body),
  };
}

describe("trusted New API identity v3", () => {
  it("accepts v3 while preserving v2 compatibility", () => {
    const value = identity();
    const verified = verifyTrustedIdentity(trustedIdentityHeaders(value, secret), body, {
      sharedSecret: secret,
    });
    expect(verified).toMatchObject({
      identityVersion: "v3",
      qualityBias: 17,
      formulaMode: "shadow",
    });

    const legacy: TrustedNewApiIdentity = {
      ...value,
      identityVersion: undefined,
      qualityBias: undefined,
      supplyStrategy: undefined,
      supplyWeights: undefined,
      acuHighBiasOffset: undefined,
      modelCostLogScale: undefined,
      profileCostLogScale: undefined,
      profileSpeedLogScale: undefined,
      latencyPolicy: undefined,
      reliabilityPolicy: undefined,
      workPhaseBiasOffsets: undefined,
      routingUtilityVersion: undefined,
      formulaMode: undefined,
    };
    expect(
      verifyTrustedIdentity(trustedIdentityHeaders(legacy, secret), body, { sharedSecret: secret })
        .identityVersion,
    ).toBe("v2");
    expect(resolvedRoutingUtilityPolicy(verified).candidatePreferenceScores).toEqual({});
    expect(resolvedRoutingUtilityPolicy(verified).allowedCandidateIds).toEqual([]);
    expect(resolvedRoutingUtilityPolicy(
      verifyTrustedIdentity(trustedIdentityHeaders(legacy, secret), body, { sharedSecret: secret }),
    ).candidatePreferenceScores).toEqual({});
  });

  it("accepts canonical v4 candidate policy and rejects tampering or duplicate JSON keys", () => {
    const value: TrustedNewApiIdentity = {
      ...identity(),
      identityVersion: "v4",
      formulaMode: "active",
      allowedCandidateIds: ["gpt-5.6-luna@max", "gpt-5.6-sol@high"],
      candidatePreferenceScores: {
        "gpt-5.6-sol@high": 70,
        "gpt-5.6-luna@max": 150.5,
      },
    };
    const headers = trustedIdentityHeaders(value, secret);
    expect(headers["x-acu-allowed-candidate-ids"]).toBe('["gpt-5.6-luna@max","gpt-5.6-sol@high"]');
    expect(headers["x-acu-candidate-preference-scores"]).toBe(
      '{"gpt-5.6-luna@max":150.5,"gpt-5.6-sol@high":70}',
    );
    const verified = verifyTrustedIdentity(headers, body, { sharedSecret: secret });
    expect(verified.candidatePreferenceScores).toEqual(value.candidatePreferenceScores);
    expect(resolvedRoutingUtilityPolicy(verified).formulaMode).toBe("active");

    for (const tampered of [
      { ...headers, "x-acu-candidate-preference-scores": '{"gpt-5.6-luna@max":160,"gpt-5.6-sol@high":70}' },
      { ...headers, "x-acu-allowed-candidate-ids": '["gpt-5.6-luna@max","gpt-5.6-sol@high","gpt-5.6-terra@max"]' },
    ]) {
      expect(() => verifyTrustedIdentity(tampered, body, { sharedSecret: secret })).toThrow("signature mismatch");
    }
    const duplicate = {
      ...headers,
      "x-acu-candidate-preference-scores": '{"gpt-5.6-luna@max":150,"gpt-5.6-luna@max":150}',
    };
    expect(() => verifyTrustedIdentity(duplicate, body, { sharedSecret: secret })).toThrow("not canonical");
  });

  it("rejects invalid v4 preference shape, IDs, scores, and counts", () => {
    for (const candidatePreferenceScores of [
      { "": 150 },
      { "gpt-5.6-luna@max": -1 },
      { "gpt-5.6-luna@max": "150" },
      { "gpt-5.6-luna@max": 201 },
      Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`model-${index}`, 150])),
    ]) {
      const value: TrustedNewApiIdentity = {
        ...identity(), identityVersion: "v4",
        allowedCandidateIds: Object.keys(candidatePreferenceScores).filter(Boolean).sort(),
        candidatePreferenceScores,
      };
      expect(() => verifyTrustedIdentity(trustedIdentityHeaders(value, secret), body, { sharedSecret: secret }))
        .toThrow("candidate");
    }

    const malformed = {
      ...trustedIdentityHeaders({
        ...identity(), identityVersion: "v4", allowedCandidateIds: [], candidatePreferenceScores: {},
      }, secret),
      "x-acu-candidate-preference-scores": "{",
    };
    expect(() => verifyTrustedIdentity(malformed, body, { sharedSecret: secret })).toThrow();
  });

  it.each([
    ["x-acu-quality-bias", "18"],
    ["x-acu-supply-strategy", "lowest_cost"],
    ["x-acu-formula-mode", "active"],
    ["x-acu-profile-speed-log-scale", "3"],
  ])("rejects a signed field changed after signing: %s", (header, value) => {
    const headers = trustedIdentityHeaders(identity(), secret);
    headers[header] = value;
    expect(() => verifyTrustedIdentity(headers, body, { sharedSecret: secret })).toThrow(
      "signature mismatch",
    );
  });

  it("rejects invalid bias and weight contracts before routing", () => {
    const invalidBias = identity();
    invalidBias.qualityBias = 101;
    expect(() =>
      verifyTrustedIdentity(trustedIdentityHeaders(invalidBias, secret), body, {
        sharedSecret: secret,
      }),
    ).toThrow("quality bias");
    const invalidWeights = identity();
    invalidWeights.supplyWeights = { cost: 40, speed: 25, reliability: 34 };
    expect(() =>
      verifyTrustedIdentity(trustedIdentityHeaders(invalidWeights, secret), body, {
        sharedSecret: secret,
      }),
    ).toThrow("supply weights");
  });
});
