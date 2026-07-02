import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from "undici";

type UpstreamProxyOptions = {
  env?: Record<string, string | undefined>;
  setDispatcher?: (dispatcher: unknown) => void;
};

function isHttpProxy(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function applyUpstreamProxy(
  explicitProxy?: string,
  options: UpstreamProxyOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const setDispatcher = options.setDispatcher ?? setGlobalDispatcher;
  const blockrunProxy = explicitProxy || env.BLOCKRUN_UPSTREAM_PROXY;

  if (blockrunProxy) {
    if (!isHttpProxy(blockrunProxy)) {
      console.warn(`[ClawRouter] Ignoring invalid BLOCKRUN_UPSTREAM_PROXY: ${blockrunProxy}`);
      return undefined;
    }
    setDispatcher(new ProxyAgent(blockrunProxy));
    return blockrunProxy;
  }

  const standardProxy = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
  if (!standardProxy) return undefined;
  if (!isHttpProxy(standardProxy)) {
    if (/^socks/i.test(standardProxy)) {
      console.warn("[ClawRouter] SOCKS proxies require BLOCKRUN_UPSTREAM_PROXY with an HTTP proxy endpoint");
    } else {
      console.warn(`[ClawRouter] Ignoring invalid upstream proxy URL: ${standardProxy}`);
    }
    return undefined;
  }

  setDispatcher(new EnvHttpProxyAgent());
  return standardProxy;
}
