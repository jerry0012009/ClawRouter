import type { IncomingHttpHeaders } from "node:http";
import { isInternalIdentityHeader } from "./trusted-identity.js";
import type { AlphaProtocol } from "./repository.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "x-api-key"]);

export type NativeProviderConfig = {
  provider: string;
  channel: string;
  baseUrl: string;
  apiKey: string;
  authMode: "bearer" | "x-api-key";
  anthropicVersion?: string;
  stripV1Path?: boolean;
};

export type NativeProviderRequest = {
  protocol: AlphaProtocol;
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
  signal: AbortSignal;
};

export type NativeProviderAdapter = {
  execute(request: NativeProviderRequest): Promise<Response>;
};

function targetUrl(config: NativeProviderConfig, path: string, query: string): URL {
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  const baseUrl = new URL(base);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const relative =
    (config.stripV1Path || baseUrl.pathname.endsWith("/v1/")) && normalizedPath.startsWith("/v1/")
      ? normalizedPath.slice("/v1/".length)
      : normalizedPath.slice(1);
  const url = new URL(relative, base);
  url.search = query;
  return url;
}

function providerHeaders(
  config: NativeProviderConfig,
  protocol: AlphaProtocol,
  headers: IncomingHttpHeaders,
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      CREDENTIAL_HEADERS.has(normalized) ||
      isInternalIdentityHeader(normalized)
    )
      continue;
    if (Array.isArray(value)) value.forEach((item) => result.append(name, item));
    else result.set(name, value);
  }
  if (config.authMode === "bearer") result.set("authorization", `Bearer ${config.apiKey}`);
  else result.set("x-api-key", config.apiKey);
  if (protocol === "messages" && !result.has("anthropic-version")) {
    result.set("anthropic-version", config.anthropicVersion ?? "2023-06-01");
  }
  return result;
}

export function createNativeProviderAdapter(config: NativeProviderConfig): NativeProviderAdapter {
  return {
    execute(request) {
      return fetch(targetUrl(config, request.path, request.query), {
        method: "POST",
        headers: providerHeaders(config, request.protocol, request.headers),
        body: Buffer.from(request.body),
        signal: request.signal,
        redirect: "manual",
      });
    },
  };
}

export function isHopByHopHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}
