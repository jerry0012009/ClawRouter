import { describe, expect, it } from "vitest";
import {
  bodySha256,
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
