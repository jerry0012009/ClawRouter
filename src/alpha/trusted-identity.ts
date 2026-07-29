import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const INTERNAL_HEADER_NAMES = [
  "x-acu-newapi-user-id",
  "x-acu-newapi-token-id",
  "x-acu-newapi-log-id",
  "x-acu-request-id",
  "x-acu-client-version",
  "x-acu-routing-policy",
  "x-acu-allowed-model-ids",
  "x-acu-routing-policy-version",
  "x-acu-timestamp",
  "x-acu-body-sha256",
  "x-acu-signature",
] as const;

export type TrustedNewApiIdentity = {
  newapiUserId: string;
  newapiTokenId: string;
  newapiLogId: string;
  requestId: string;
  clientVersion?: string;
  routingPolicy: "all_routing_eligible" | "custom_allowlist" | "explicit_only";
  allowedModelIds: string[];
  routingPolicyVersion: string;
  timestamp: string;
  bodySha256: string;
};

export type IdentityVerificationOptions = {
  sharedSecret: string;
  now?: Date;
  maxClockSkewSeconds?: number;
};

function singleHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (Array.isArray(value) || typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing or repeated trusted identity header: ${name}`);
  }
  return value;
}

export function bodySha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function trustedIdentitySigningPayload(identity: TrustedNewApiIdentity): string {
  return [
    identity.newapiUserId,
    identity.newapiTokenId,
    identity.newapiLogId,
    identity.requestId,
    identity.clientVersion ?? "unknown",
    identity.routingPolicy,
    JSON.stringify(identity.allowedModelIds),
    identity.routingPolicyVersion,
    identity.timestamp,
    identity.bodySha256,
  ].join("\n");
}

export function signTrustedIdentity(identity: TrustedNewApiIdentity, sharedSecret: string): string {
  return createHmac("sha256", sharedSecret).update(trustedIdentitySigningPayload(identity)).digest("hex");
}

export function trustedIdentityHeaders(
  identity: TrustedNewApiIdentity,
  sharedSecret: string,
): Record<string, string> {
  return {
    "x-acu-newapi-user-id": identity.newapiUserId,
    "x-acu-newapi-token-id": identity.newapiTokenId,
    "x-acu-newapi-log-id": identity.newapiLogId,
    "x-acu-request-id": identity.requestId,
    "x-acu-client-version": identity.clientVersion ?? "unknown",
    "x-acu-routing-policy": identity.routingPolicy,
    "x-acu-allowed-model-ids": JSON.stringify(identity.allowedModelIds),
    "x-acu-routing-policy-version": identity.routingPolicyVersion,
    "x-acu-timestamp": identity.timestamp,
    "x-acu-body-sha256": identity.bodySha256,
    "x-acu-signature": signTrustedIdentity(identity, sharedSecret),
  };
}

export function verifyTrustedIdentity(
  headers: IncomingHttpHeaders,
  body: Uint8Array,
  options: IdentityVerificationOptions,
): TrustedNewApiIdentity {
  if (!options.sharedSecret) throw new Error("Trusted identity shared secret is not configured");
  const identity: TrustedNewApiIdentity = {
    newapiUserId: singleHeader(headers, INTERNAL_HEADER_NAMES[0]),
    newapiTokenId: singleHeader(headers, INTERNAL_HEADER_NAMES[1]),
    newapiLogId: singleHeader(headers, INTERNAL_HEADER_NAMES[2]),
    requestId: singleHeader(headers, INTERNAL_HEADER_NAMES[3]),
    clientVersion: singleHeader(headers, INTERNAL_HEADER_NAMES[4]),
    routingPolicy: singleHeader(headers, INTERNAL_HEADER_NAMES[5]) as TrustedNewApiIdentity["routingPolicy"],
    allowedModelIds: JSON.parse(singleHeader(headers, INTERNAL_HEADER_NAMES[6])) as string[],
    routingPolicyVersion: singleHeader(headers, INTERNAL_HEADER_NAMES[7]),
    timestamp: singleHeader(headers, INTERNAL_HEADER_NAMES[8]),
    bodySha256: singleHeader(headers, INTERNAL_HEADER_NAMES[9]),
  };
  const signature = singleHeader(headers, INTERNAL_HEADER_NAMES[10]);
  if (!["all_routing_eligible", "custom_allowlist", "explicit_only"].includes(identity.routingPolicy)) {
    throw new Error("Trusted routing policy is invalid");
  }
  if (!Array.isArray(identity.allowedModelIds)
    || identity.allowedModelIds.length > 64
    || identity.allowedModelIds.some((modelId) => typeof modelId !== "string" || modelId.length < 1 || modelId.length > 128)
    || new Set(identity.allowedModelIds).size !== identity.allowedModelIds.length) {
    throw new Error("Trusted routing model allowlist is invalid");
  }
  if (identity.routingPolicy === "custom_allowlist" && identity.allowedModelIds.length === 0) {
    throw new Error("Trusted custom routing allowlist is empty");
  }
  if (!/^acu-user-policy-v1-[a-f0-9]{16}$/.test(identity.routingPolicyVersion)) {
    throw new Error("Trusted routing policy version is invalid");
  }
  const timestampMs = Date.parse(identity.timestamp);
  if (!Number.isFinite(timestampMs)) throw new Error("Trusted identity timestamp is invalid");
  const skewMs = Math.abs((options.now ?? new Date()).getTime() - timestampMs);
  if (skewMs > (options.maxClockSkewSeconds ?? 300) * 1_000) {
    throw new Error("Trusted identity timestamp is outside the accepted window");
  }
  const actualBodyHash = bodySha256(body);
  if (identity.bodySha256 !== actualBodyHash) throw new Error("Trusted identity body hash mismatch");
  const expected = Buffer.from(signTrustedIdentity(identity, options.sharedSecret), "hex");
  const received = /^[a-f0-9]{64}$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Trusted identity signature mismatch");
  }
  return identity;
}

export function isInternalIdentityHeader(name: string): boolean {
  return INTERNAL_HEADER_NAMES.includes(name.toLowerCase() as (typeof INTERNAL_HEADER_NAMES)[number]);
}
