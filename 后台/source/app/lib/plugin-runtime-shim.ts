/**
 * Generic ZIP/Vite plugins are built with `base: "/"`, so their bundles ask for
 * `/models/x.glb` or `/assets/x.wasm`. Inside the signed runtime route those
 * root-absolute paths leave the session prefix and hit the host app instead.
 * This shim turns the runtime root into the place a root-absolute URL resolves
 * to, both while rewriting static text and at runtime inside the sandbox.
 */

// Host-owned prefixes keep working: a plugin that intentionally calls the host
// API must not have that request swallowed by its own package root.
const HOST_OWNED_PATH_PREFIXES = ["/api/", "/_next/"] as const;

/**
 * The runtime root is the directory that owns the requested file, i.e. the
 * request path minus the trailing file segments. Deriving it from the request
 * keeps the session token and whichever origin the host was opened through.
 */
export function runtimeRootFromRequest(
  request: Request,
  params: { path?: string[] },
) {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const keep = segments.length - (params.path?.length ?? 0);
  if (keep < 1) return `${url.origin}/`;
  return `${url.origin}/${segments.slice(0, keep).join("/")}/`;
}

function escapeRuntimeRoot(pathname: string, rootPathname: string) {
  if (rootPathname !== "/" && pathname.startsWith(rootPathname)) return false;
  return !HOST_OWNED_PATH_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix),
  );
}

function isHttpScheme(value: string) {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(value)?.[0]?.toLowerCase();
  return scheme === "http:" || scheme === "https:";
}

export function rewriteRuntimeUrl(raw: string, runtimeRoot: string): string {
  if (!raw) return raw;

  if (raw.startsWith("//")) return raw;

  if (raw.startsWith("/")) {
    const pathname = raw.split("?")[0].split("#")[0];
    const root = new URL(runtimeRoot);
    return escapeRuntimeRoot(pathname, root.pathname)
      ? `${runtimeRoot}${raw.slice(1)}`
      : raw;
  }

  if (!isHttpScheme(raw)) return raw;

  try {
    const root = new URL(runtimeRoot);
    const target = new URL(raw);
    if (target.origin !== root.origin) return raw;
    if (!escapeRuntimeRoot(target.pathname, root.pathname)) return raw;
    return `${runtimeRoot}${target.pathname.slice(1)}${target.search}${target.hash}`;
  } catch {
    return raw;
  }
}

function injectRuntimeShim(html: string, runtimeRoot: string) {
  const tag = `<script data-xiaoluo-runtime-shim>${pluginRuntimeShimScript(
    runtimeRoot,
  )}</script>`;
  const moduleScript = /<script[^>]*\btype=["']module["']/i.exec(html);
  if (moduleScript) {
    return `${html.slice(0, moduleScript.index)}${tag}${html.slice(
      moduleScript.index,
    )}`;
  }
  const headClose = /<\/head>/i.exec(html);
  if (headClose) {
    return `${html.slice(0, headClose.index)}${tag}${html.slice(
      headClose.index,
    )}`;
  }
  return `${tag}${html}`;
}

/**
 * Rewrites the two text formats a plugin asks for by path. Markup URLs are
 * absolute in the source build, so they move under the signed runtime root
 * together with the JavaScript shim that covers runtime-constructed URLs.
 */
export function rewriteRuntimeStaticText(
  bytes: Uint8Array,
  extension: string,
  runtimeRoot: string,
): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  if (extension === "html") {
    const rewritten = text
      .replace(
        /\b(src|href)=(["'])(\/[^"']*)/gi,
        (_match, attribute: string, quote: string, value: string) =>
          `${attribute}=${quote}${rewriteRuntimeUrl(value, runtimeRoot)}`,
      )
      .replace(/<base[\s\S]*?>/gi, "");
    return new TextEncoder().encode(injectRuntimeShim(rewritten, runtimeRoot));
  }

  if (extension === "css") {
    return new TextEncoder().encode(
      text.replace(
        /url\((["']?)\/(?!\/)/gi,
        (_match, quote: string) => `url(${quote}${runtimeRoot}`,
      ),
    );
  }

  return bytes;
}

/**
 * Injected before the plugin's own modules. Markup rewriting cannot help a
 * bundled `fetch("/models/x.glb")`, because that URL is built in JavaScript, so
 * the network entry points themselves have to resolve against the runtime root.
 */
export function pluginRuntimeShimScript(runtimeRoot: string) {
  const root = new URL(runtimeRoot);
  return `(function () {
  var rootHref = ${JSON.stringify(runtimeRoot)};
  var rootPath = ${JSON.stringify(root.pathname)};
  var rootOrigin = ${JSON.stringify(root.origin)};
  var hostOwned = ${JSON.stringify(HOST_OWNED_PATH_PREFIXES)};
  if (window.__XIAOLUO_RUNTIME_BASE__ === rootHref) return;
  window.__XIAOLUO_RUNTIME_BASE__ = rootHref;

  function needsRewrite(pathname) {
    if (rootPath !== "/" && pathname.indexOf(rootPath) === 0) return false;
    for (var i = 0; i < hostOwned.length; i += 1) {
      if (pathname.indexOf(hostOwned[i]) === 0) return false;
    }
    return true;
  }

  function rewrite(raw) {
    if (typeof raw !== "string" || !raw) return raw;
    if (raw.charAt(0) === "/") {
      if (raw.charAt(1) === "/") return raw;
      var pathname = raw.split("?")[0].split("#")[0];
      return needsRewrite(pathname) ? rootHref + raw.slice(1) : raw;
    }
    var scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(raw);
    if (!scheme) return raw;
    var lower = scheme[0].toLowerCase();
    if (lower !== "http:" && lower !== "https:") return raw;
    try {
      var target = new URL(raw);
      if (target.origin !== rootOrigin || !needsRewrite(target.pathname)) {
        return raw;
      }
      return rootHref + target.pathname.slice(1) + target.search + target.hash;
    } catch (error) {
      return raw;
    }
  }

  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.href === "string") return input.href;
    if (input && typeof input.url === "string") return input.url;
    return null;
  }

  if (typeof window.fetch === "function") {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var raw = urlOf(input);
      var rewritten = raw === null ? input : rewrite(raw);
      if (rewritten === raw) return originalFetch.call(this, input, init);
      return originalFetch.call(this, rewritten, init);
    };
  }

  if (typeof window.Request === "function") {
    var OriginalRequest = window.Request;
    var PatchedRequest = function (input, init) {
      var raw = urlOf(input);
      var rewritten = raw === null ? input : rewrite(raw);
      return new OriginalRequest(rewritten, init);
    };
    PatchedRequest.prototype = OriginalRequest.prototype;
    Object.setPrototypeOf(PatchedRequest, OriginalRequest);
    window.Request = PatchedRequest;
  }

  if (typeof window.XMLHttpRequest === "function") {
    var originalOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function () {
      var args = Array.prototype.slice.call(arguments);
      if (typeof args[1] === "string") args[1] = rewrite(args[1]);
      return originalOpen.apply(this, args);
    };
  }

  if (typeof window.EventSource === "function") {
    var OriginalEventSource = window.EventSource;
    var PatchedEventSource = function (url, config) {
      return new OriginalEventSource(rewrite(url), config);
    };
    PatchedEventSource.prototype = OriginalEventSource.prototype;
    Object.setPrototypeOf(PatchedEventSource, OriginalEventSource);
    window.EventSource = PatchedEventSource;
  }

  if (typeof window.Element === "function") {
    var originalSetAttribute = window.Element.prototype.setAttribute;
    if (typeof originalSetAttribute === "function") {
      window.Element.prototype.setAttribute = function (name, value) {
        var lower = typeof name === "string" ? name.toLowerCase() : "";
        if ((lower === "src" || lower === "href") && typeof value === "string") {
          value = rewrite(value);
        }
        return originalSetAttribute.call(this, name, value);
      };
    }
  }

  function patchSetter(ctor, attribute) {
    var proto = ctor && ctor.prototype;
    if (!proto) return;
    var descriptor = Object.getOwnPropertyDescriptor(proto, attribute);
    if (!descriptor || typeof descriptor.set !== "function") return;
    if (descriptor.set.__xiaoluoRuntimeShim) return;
    var originalSet = descriptor.set;
    var setter = function (value) {
      originalSet.call(this, rewrite(value));
    };
    setter.__xiaoluoRuntimeShim = true;
    Object.defineProperty(proto, attribute, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set: setter,
    });
  }

  patchSetter(window.HTMLImageElement, "src");
  patchSetter(window.HTMLScriptElement, "src");
  patchSetter(window.HTMLLinkElement, "href");
  patchSetter(window.HTMLMediaElement, "src");
  patchSetter(window.HTMLSourceElement, "src");

  try {
    console.info("[小逻] 插件根路径已映射到签名运行会话 " + rootPath);
  } catch (error) {}
})();`;
}
