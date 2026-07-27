(function attachAcuApiPrefix(root) {
  function resolve(pathname, origin) {
    const prefix = String(pathname || "").match(/^\/(acu-router(?:-dev)?)(?:\/|$)/)?.[1];
    return prefix ? `${origin}/${prefix}` : origin;
  }

  function assertSafeTarget(pathname, target) {
    const pagePath = String(pathname || "");
    const requestUrl = String(target || "");
    if (pagePath.includes("/acu-router-dev") && /\/acu-router\//.test(requestUrl) && !/\/acu-router-dev\//.test(requestUrl)) {
      throw new Error("Dev page attempted to call production API.");
    }
  }

  function fetchFrom(pathname, target, options) {
    assertSafeTarget(pathname, target);
    return root.fetch(target, options);
  }

  root.AcuApiPrefix = { resolve, assertSafeTarget, fetchFrom };
})(typeof window === "undefined" ? globalThis : window);
