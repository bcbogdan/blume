import { describe, expect, it } from "bun:test";

import {
  ACCEPT_JSON_HEADER_VALUE,
  ACCEPT_MARKDOWN_HEADER_VALUE,
  buildNegotiationRoutes,
  injectNegotiationRoutes,
} from "../src/deploy/vercel-negotiation.ts";
import type { VercelRoute } from "../src/deploy/vercel-negotiation.ts";

// The router's matching semantics aren't contractual — exercise the pattern
// both as a substring match and wrapped as a full-string match, since it must
// behave identically either way.
const partial = new RegExp(ACCEPT_MARKDOWN_HEADER_VALUE, "u");
const full = new RegExp(`^(?:${ACCEPT_MARKDOWN_HEADER_VALUE})$`, "u");

const matchesBoth = (accept: string): boolean => {
  const a = partial.test(accept);
  const b = full.test(accept);
  expect(a).toBe(b);
  return a;
};

describe("accept-header pattern", () => {
  it("matches Markdown accept headers under both matching semantics", () => {
    expect(matchesBoth("text/markdown")).toBe(true);
    expect(matchesBoth("text/x-markdown")).toBe(true);
    expect(matchesBoth("text/markdown;q=0.9")).toBe(true);
    expect(matchesBoth("text/markdown, */*")).toBe(true);
    expect(matchesBoth("text/html, text/markdown;q=0.9")).toBe(true);
    expect(matchesBoth("application/json,text/markdown")).toBe(true);
  });

  it("rejects browser and non-Markdown accept headers", () => {
    expect(matchesBoth("text/html")).toBe(false);
    expect(
      matchesBoth("text/html,application/xhtml+xml,application/xml;q=0.9,*/*")
    ).toBe(false);
    expect(matchesBoth("*/*")).toBe(false);
    expect(matchesBoth("application/json")).toBe(false);
    // A longer media type must not match on its `text/markdown` prefix.
    expect(matchesBoth("text/markdownx")).toBe(false);
  });
});

describe("buildNegotiationRoutes", () => {
  it("builds a conditional rewrite and a Vary route over the content routes", () => {
    const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes([
      "/docs/a",
      "/docs/b",
    ]);
    expect(rewriteRoutes).toStrictEqual([
      {
        dest: "$1.md",
        has: [
          {
            key: "accept",
            type: "header",
            value: ACCEPT_MARKDOWN_HEADER_VALUE,
          },
        ],
        headers: { vary: "Accept" },
        src: "^(/docs/a|/docs/b)/?$",
      },
    ]);
    expect(headerRoutes).toStrictEqual([
      {
        continue: true,
        headers: { vary: "Accept" },
        src: "^(?:/docs/a|/docs/b)/?$",
      },
    ]);
  });

  it("rewrites a matched page URL to its .md mirror, trailing slash included", () => {
    const { rewriteRoutes } = buildNegotiationRoutes(["/docs/a", "/docs/b"]);
    const [route] = rewriteRoutes;
    const src = new RegExp(route?.src ?? "", "u");
    expect("/docs/b/".replace(src, route?.dest ?? "")).toBe("/docs/b.md");
    expect("/docs/a".replace(src, route?.dest ?? "")).toBe("/docs/a.md");
    expect(src.test("/docs/ab")).toBe(false);
    expect(src.test("/logo.png")).toBe(false);
  });

  it("maps the home page to /index.md via a dedicated route", () => {
    const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes([
      "/",
      "/guide",
    ]);
    expect(rewriteRoutes[0]).toMatchObject({
      dest: "/index.md",
      src: "^/$",
    });
    expect(rewriteRoutes[1]?.src).toBe("^(/guide)/?$");
    // The Vary route covers the home page alongside the rest.
    const vary = new RegExp(headerRoutes[0]?.src ?? "", "u");
    expect(vary.test("/")).toBe(true);
    expect(vary.test("/guide")).toBe(true);
  });

  it("stamps x-markdown-tokens on the home rewrite when a count is given", () => {
    const { rewriteRoutes } = buildNegotiationRoutes(["/", "/guide"], 128);
    expect(rewriteRoutes[0]?.headers).toStrictEqual({
      vary: "Accept",
      "x-markdown-tokens": "128",
    });
    // Chunked rewrites span many pages, so a per-page count never rides them.
    expect(rewriteRoutes[1]?.headers).toStrictEqual({ vary: "Accept" });
    // Without a count the home rewrite stays as before.
    const plain = buildNegotiationRoutes(["/", "/guide"]);
    expect(plain.rewriteRoutes[0]?.headers).toStrictEqual({ vary: "Accept" });
  });

  it("percent-encodes and regex-escapes route paths", () => {
    const { rewriteRoutes } = buildNegotiationRoutes([
      "/ja/はじめに",
      "/docs/c++ (v2)",
    ]);
    const src = rewriteRoutes[0]?.src ?? "";
    expect(src).toContain(encodeURI("/ja/はじめに"));
    expect(src).toContain("/docs/c\\+\\+%20\\(v2\\)");
    const pattern = new RegExp(src, "u");
    expect(pattern.test(encodeURI("/ja/はじめに"))).toBe(true);
    expect(pattern.test("/docs/cxx (v2)")).toBe(false);
  });

  it("splits large route sets across entries under the src length limit", () => {
    const routes = Array.from(
      { length: 300 },
      (_, index) => `/docs/section-${index}/some-fairly-long-page-slug-${index}`
    );
    const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes(routes);
    expect(rewriteRoutes.length).toBeGreaterThan(1);
    for (const route of [...rewriteRoutes, ...headerRoutes]) {
      expect((route.src ?? "").length).toBeLessThan(4096);
    }
    // Every route is matched by exactly one rewrite entry.
    for (const path of routes) {
      const matches = rewriteRoutes.filter((route) =>
        new RegExp(route.src ?? "", "u").test(path)
      );
      expect(matches).toHaveLength(1);
    }
  });
});

interface AdapterFixture {
  routes: [VercelRoute, VercelRoute, VercelRoute, VercelRoute];
  version: number;
}

const baseConfig: AdapterFixture = {
  routes: [
    { handle: "filesystem" },
    {
      continue: true,
      headers: { "cache-control": "public, max-age=31536000, immutable" },
      src: "^/_astro/(.*)$",
    },
    { dest: "_render", src: "^/api/ask/?$" },
    { dest: "/404.html", src: "^/.*$", status: 404 },
  ],
  version: 3,
};

const injectRedirectFixture = (routes: VercelRoute[]) => {
  const once = injectNegotiationRoutes(
    JSON.stringify({ routes, version: 3 }),
    [],
    null,
    undefined,
    undefined,
    { json: true, markdown: true }
  );
  expect(once).not.toBeNull();
  expect(
    injectNegotiationRoutes(once ?? "", [], null, undefined, undefined, {
      json: true,
      markdown: true,
    })
  ).toBe(once);
  const result: { routes: VercelRoute[] } = JSON.parse(once ?? "");
  return result.routes.filter((route) => route.src !== "^/(.+)/$");
};

describe("conservative redirect deduplication", () => {
  const direct: VercelRoute = {
    headers: { Location: "/new" },
    src: "^/old$",
    status: 301,
  };
  const fallback: VercelRoute = { dest: "_render", src: "^/old$" };
  const filesystem = { handle: "filesystem" };
  const [, assetHeaders] = baseConfig.routes;
  const inject = injectRedirectFixture;

  it("drops an identical literal fallback without changing the redirect or filesystem order", () => {
    // @astrojs/vercel 11.0.10 normalizes getTransformedRoutes redirects before
    // filesystem, then Astro 7.3.2 route.patternRegex fallbacks. With
    // trailingSlash: never, both normalized patterns are ^/old$.
    const other = {
      headers: { Location: "/elsewhere" },
      src: "^/other$",
      status: 307,
    };
    expect(inject([direct, other, filesystem, assetHeaders, fallback])).toEqual(
      [direct, other, filesystem, assetHeaders]
    );
    expect(direct.src).toBe("^/old$");
    expect(new RegExp(direct.src ?? "", "u").test("/old/")).toBe(false);
  });

  it("keeps statuses, locations, and ordering for identical slash and root patterns", () => {
    for (const src of ["^/old/$", "^/old/?$", "^/$"]) {
      const redirect = { ...direct, src, status: 308 };
      expect(inject([redirect, filesystem, { ...fallback, src }])).toEqual([
        redirect,
        filesystem,
      ]);
    }
    const second = { ...direct, src: "^/second$", status: 302 };
    expect(
      inject([
        direct,
        second,
        filesystem,
        { ...fallback, src: second.src },
        fallback,
      ])
    ).toEqual([direct, second, filesystem]);
  });

  it("preserves the adapter's optional-slash fallback, including slash-specific conflicts", () => {
    // Actual normalized adapter output under trailingSlash: ignore differs by
    // /?. Widening the direct redirect would take /old/ away from this route.
    const slash = {
      headers: { Location: "/slash-owner" },
      src: "^/old/$",
      status: 302,
    };
    const optional = { ...fallback, src: "^/old/?$" };
    for (const conflict of [
      slash,
      { dest: "/static-owner.html", src: "^/old/$" },
    ]) {
      const routes = [direct, conflict, filesystem, optional];
      expect(inject(routes)).toEqual(routes);
    }
    const routes = [direct, filesystem, optional];
    expect(inject(routes)).toEqual(routes);
    // Even with no competing route, /old/ can belong to the static filesystem.
    expect(new RegExp(direct.src ?? "", "u").test("/old/")).toBe(false);
    expect(new RegExp(optional.src, "u").test("/old/")).toBe(true);
  });

  it("leaves captures and their substitutions untouched", () => {
    const redirect = {
      headers: { Location: "/new/$1/$2" },
      src: "^/old/([^/]+?)/(.*?)$",
      status: 301,
    };
    for (const src of [redirect.src, "^/old/([^/]+?)/(.*?)/?$"]) {
      const routes = [redirect, filesystem, { ...fallback, src }];
      expect(inject(routes)).toEqual(routes);
    }
    expect(
      "/old/first/rest/of/path".replace(
        new RegExp(redirect.src, "u"),
        redirect.headers.Location
      )
    ).toBe("/new/first/rest/of/path");
  });

  it("leaves duplicate pairs and direct redirects ambiguous", () => {
    for (const routes of [
      [direct, direct, filesystem, fallback],
      [direct, filesystem, fallback, fallback],
      [direct, direct, filesystem, fallback, fallback],
      [direct, filesystem, filesystem, fallback],
      [filesystem, fallback, direct],
    ]) {
      expect(inject(routes)).toEqual(routes);
    }
  });

  it("does not cross rewrites, phase controls, or extra fields", () => {
    const extraFields = [
      { has: [{ key: "x-test", type: "header", value: "yes" }] },
      { missing: [{ key: "x-test", type: "header" }] },
      { methods: ["GET"] },
      { continue: true },
      { middlewarePath: "_middleware" },
    ];
    for (const extra of extraFields) {
      for (const routes of [
        [{ ...direct, ...extra }, filesystem, fallback],
        [direct, filesystem, { ...fallback, ...extra }],
      ]) {
        expect(inject(routes)).toEqual(routes);
      }
    }
    const barriers: VercelRoute[] = [
      { continue: true, dest: "/old", src: "^/alias$" },
      { handle: "rewrite" },
      { headers: { "x-test": "yes" }, src: "^/old$" },
      { ...direct, headers: { Location: "/new", "x-test": "yes" } },
      { ...direct, status: 304 },
    ];
    for (const barrier of barriers) {
      const routes = [direct, filesystem, barrier, fallback];
      expect(inject(routes)).toEqual(routes);
    }
    const extraFilesystem = [direct, { ...filesystem, extra: true }, fallback];
    expect(inject(extraFilesystem)).toEqual(extraFilesystem);
  });

  it("preserves newer API routing and negotiated 404s after deduplication", () => {
    const api = { dest: "_render", src: "^/api/.*$" };
    const routes = inject([
      direct,
      filesystem,
      fallback,
      api,
      baseConfig.routes[3],
    ]);
    expect(routes[0]).toEqual(direct);
    expect(routes[1]).toEqual(filesystem);
    expect(routes[2]).toEqual(api);
    expect(routes.slice(3).map((route) => route.dest)).toEqual([
      "/404.md",
      "/404.md",
      "/404.json",
      "/404.json",
      "/404.html",
    ]);
  });
});

describe("injectNegotiationRoutes", () => {
  it("splices Vary routes then rewrites, all before handle:filesystem", () => {
    const injected = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    expect(injected).not.toBeNull();
    const config = JSON.parse(injected ?? "");
    expect(config.version).toBe(3);
    expect(config.routes.map((route: { src?: string }) => route.src)).toEqual([
      "^(?:/docs/a)/?$",
      "^(/docs/a)/?$",
      "^/(.+)/$",
      undefined,
      "^/_astro/(.*)$",
      "^/api/ask/?$",
      "^/.*$",
    ]);
    expect(config.routes[3]).toStrictEqual({ handle: "filesystem" });
    expect(config.routes[0].continue).toBe(true);
    expect(config.routes[1].dest).toBe("$1.md");
  });

  it("splices a trailing-slash 308 redirect after the rewrites", () => {
    const injected = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    const config = JSON.parse(injected ?? "");
    const redirect = config.routes.find(
      (route: { status?: number }) => route.status === 308
    );
    expect(redirect).toStrictEqual({
      headers: { Location: "/$1" },
      src: "^/(.+)/$",
      status: 308,
    });
    // Main phase, after the Markdown rewrite (so a slashed URL's negotiation
    // rewrites directly) and before handle:filesystem (so it actually fires
    // for prerendered pages).
    const redirectIndex = config.routes.indexOf(redirect);
    const rewriteIndex = config.routes.findIndex(
      (route: { dest?: string }) => route.dest === "$1.md"
    );
    const filesystemIndex = config.routes.findIndex(
      (route: { handle?: string }) => route.handle === "filesystem"
    );
    expect(redirectIndex).toBeGreaterThan(rewriteIndex);
    expect(redirectIndex).toBeLessThan(filesystemIndex);
    // The pattern spares the root and strips exactly one trailing slash.
    const src = new RegExp(redirect.src, "u");
    expect(src.test("/")).toBe(false);
    expect(src.test("/docs/a")).toBe(false);
    expect("/docs/a/".replace(src, "/$1")).toBe("/docs/a");
  });

  it("is idempotent across re-injection", () => {
    const once = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
      "/docs/b",
    ]);
    const twice = injectNegotiationRoutes(once ?? "", ["/docs/a", "/docs/b"]);
    expect(twice).toBe(once ?? "");
  });

  it("emits tab-indented JSON with a trailing newline", () => {
    const injected = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    expect(injected?.endsWith("}\n")).toBe(true);
    expect(injected).toContain('\n\t"routes"');
  });

  it("splices a homepage Link route before handle:filesystem when given", () => {
    const link = '</llms.txt>; rel="describedby"; type="text/plain"';
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      link
    );
    const config = JSON.parse(injected ?? "");
    const filesystemIndex = config.routes.findIndex(
      (route: { handle?: string }) => route.handle === "filesystem"
    );
    const linkRoute = config.routes.find(
      (route: { headers?: Record<string, string> }) => route.headers?.link
    );
    expect(linkRoute).toStrictEqual({
      continue: true,
      headers: { link },
      src: "^/$",
    });
    // Main phase: the marker starts the miss phase, which prerendered static
    // responses (the homepage included) never reach.
    expect(config.routes.indexOf(linkRoute)).toBeLessThan(filesystemIndex);
  });

  it("injects only the Link route when there are no content routes", () => {
    const link = '</llms.txt>; rel="describedby"; type="text/plain"';
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      [],
      link
    );
    const config = JSON.parse(injected ?? "");
    expect(
      config.routes.filter(
        (route: { has?: unknown; headers?: Record<string, string> }) =>
          route.has || route.headers?.vary
      )
    ).toHaveLength(0);
    expect(
      config.routes.filter(
        (route: { headers?: Record<string, string> }) => route.headers?.link
      )
    ).toHaveLength(1);
  });

  it("injects the home token count and stays idempotent", () => {
    const once = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/", "/docs/a"],
      null,
      undefined,
      256
    );
    const config = JSON.parse(once ?? "");
    const homeRewrite = config.routes.find(
      (route: { dest?: string }) => route.dest === "/index.md"
    );
    expect(homeRewrite.headers).toStrictEqual({
      vary: "Accept",
      "x-markdown-tokens": "256",
    });
    // Re-injection with a fresh count replaces rather than duplicates.
    const twice = injectNegotiationRoutes(
      once ?? "",
      ["/", "/docs/a"],
      null,
      undefined,
      512
    );
    const updated = JSON.parse(twice ?? "").routes.filter(
      (route: { dest?: string }) => route.dest === "/index.md"
    );
    expect(updated).toHaveLength(1);
    expect(updated[0].headers["x-markdown-tokens"]).toBe("512");
  });

  it("replaces a previously injected Link route instead of duplicating it", () => {
    const once = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      "old"
    );
    const twice = injectNegotiationRoutes(once ?? "", ["/docs/a"], "new");
    const config = JSON.parse(twice ?? "");
    const linkRoutes = config.routes.filter(
      (route: { headers?: Record<string, string> }) => route.headers?.link
    );
    expect(linkRoutes).toHaveLength(1);
    expect(linkRoutes[0].headers.link).toBe("new");
    expect(injectNegotiationRoutes(twice ?? "", ["/docs/a"], "new")).toBe(
      twice ?? ""
    );
  });

  it("adds content-type overrides for extensionless well-known files", () => {
    const overrides = {
      ".well-known/http-message-signatures-directory":
        "application/http-message-signatures-directory+json",
    };
    const once = injectNegotiationRoutes(
      JSON.stringify({
        ...baseConfig,
        overrides: { "kept.html": { path: "kept" } },
      }),
      ["/docs/a"],
      null,
      overrides
    );
    const config = JSON.parse(once ?? "");
    expect(config.overrides).toStrictEqual({
      ".well-known/http-message-signatures-directory": {
        contentType: "application/http-message-signatures-directory+json",
      },
      "kept.html": { path: "kept" },
    });
    // Re-injection replaces the keyed entry instead of duplicating anything.
    expect(
      injectNegotiationRoutes(once ?? "", ["/docs/a"], null, overrides)
    ).toBe(once ?? "");
    // Overrides alone are enough to warrant an injection.
    const alone = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      [],
      null,
      overrides
    );
    expect(JSON.parse(alone ?? "").overrides).toBeDefined();
  });

  it("still injects the trailing-slash redirect with nothing else to add", () => {
    const text = JSON.stringify(baseConfig);
    for (const injected of [
      injectNegotiationRoutes(text, []),
      injectNegotiationRoutes(text, [], null),
      injectNegotiationRoutes(text, [], null, {}),
    ]) {
      const config = JSON.parse(injected ?? "");
      expect(
        config.routes.filter(
          (route: { status?: number }) => route.status === 308
        )
      ).toHaveLength(1);
    }
  });

  it("splices the Markdown 404 routes right before the adapter's /404.html fallback", () => {
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { markdown: true }
    );
    const config = JSON.parse(injected ?? "");
    const routes: {
      dest?: string;
      handle?: string;
      has?: { key: string; type: string; value: string }[];
      headers?: Record<string, string>;
      src?: string;
      status?: number;
    }[] = config.routes;
    const fallbackIndex = routes.findIndex(
      (route) => route.dest === "/404.html"
    );
    expect(fallbackIndex).toBeGreaterThan(0);
    // Miss phase (after handle:filesystem), after the server routes, and
    // immediately ahead of the HTML fallback.
    const filesystemIndex = routes.findIndex(
      (route) => route.handle === "filesystem"
    );
    const serverIndex = routes.findIndex((route) => route.dest === "_render");
    expect(routes[fallbackIndex - 2]).toStrictEqual({
      dest: "/404.md",
      has: [
        { key: "accept", type: "header", value: ACCEPT_MARKDOWN_HEADER_VALUE },
      ],
      headers: { vary: "Accept" },
      src: "^/.*$",
      status: 404,
    });
    expect(routes[fallbackIndex - 1]).toStrictEqual({
      dest: "/404.md",
      src: "^/.*\\.mdx?$",
      status: 404,
    });
    expect(fallbackIndex - 2).toBeGreaterThan(serverIndex);
    expect(serverIndex).toBeGreaterThan(filesystemIndex);
    // The `.md` route catches raw-mirror URLs without a page, not pages.
    const mdSrc = new RegExp(routes[fallbackIndex - 1]?.src ?? "", "u");
    expect(mdSrc.test("/docs/missing.md")).toBe(true);
    expect(mdSrc.test("/docs/missing.mdx")).toBe(true);
    expect(mdSrc.test("/docs/missing")).toBe(false);
    expect(mdSrc.test("/logo.png")).toBe(false);
  });

  it("leaves the Markdown 404 out by default and when no HTML fallback exists", () => {
    const withoutFlag = injectNegotiationRoutes(JSON.stringify(baseConfig), [
      "/docs/a",
    ]);
    expect(withoutFlag).not.toContain("/404.md");

    const noFallback = {
      routes: baseConfig.routes.filter((route) => route.status !== 404),
      version: 3,
    };
    const injected = injectNegotiationRoutes(
      JSON.stringify(noFallback),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { markdown: true }
    );
    expect(injected).not.toBeNull();
    expect(injected).not.toContain("/404.md");
  });

  it("re-injects the Markdown 404 routes idempotently", () => {
    const once = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { markdown: true }
    );
    const twice = injectNegotiationRoutes(
      once ?? "",
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { markdown: true }
    );
    expect(twice).toBe(once ?? "");
    expect((once ?? "").match(/\/404\.md/gu)).toHaveLength(2);
    // Dropping the flag on a re-injection removes them again.
    const dropped = injectNegotiationRoutes(once ?? "", ["/docs/a"]);
    expect(dropped).not.toContain("/404.md");
  });

  it("splices the JSON 404 routes at the same anchor, after the Markdown ones", () => {
    const injected = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { json: true, markdown: true }
    );
    const config = JSON.parse(injected ?? "");
    const routes: {
      dest?: string;
      has?: { key: string; type: string; value: string }[];
      headers?: Record<string, string>;
      src?: string;
      status?: number;
    }[] = config.routes;
    const fallbackIndex = routes.findIndex(
      (route) => route.dest === "/404.html"
    );
    expect(routes.slice(fallbackIndex - 4, fallbackIndex)).toStrictEqual([
      {
        dest: "/404.md",
        has: [
          {
            key: "accept",
            type: "header",
            value: ACCEPT_MARKDOWN_HEADER_VALUE,
          },
        ],
        headers: { vary: "Accept" },
        src: "^/.*$",
        status: 404,
      },
      { dest: "/404.md", src: "^/.*\\.mdx?$", status: 404 },
      {
        dest: "/404.json",
        has: [
          { key: "accept", type: "header", value: ACCEPT_JSON_HEADER_VALUE },
        ],
        headers: { vary: "Accept" },
        src: "^/.*$",
        status: 404,
      },
      { dest: "/404.json", src: "^/.*\\.json$", status: 404 },
    ]);
    // The `.json` route catches JSON URLs no file backs, nothing else.
    const jsonSrc = new RegExp(routes[fallbackIndex - 1]?.src ?? "", "u");
    expect(jsonSrc.test("/api/docs/pages/missing.json")).toBe(true);
    expect(jsonSrc.test("/docs/missing")).toBe(false);
    expect(jsonSrc.test("/docs/missing.md")).toBe(false);

    // JSON alone, and idempotently.
    const jsonOnly = injectNegotiationRoutes(
      JSON.stringify(baseConfig),
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { json: true }
    );
    expect(jsonOnly).not.toContain("/404.md");
    expect((jsonOnly ?? "").match(/\/404\.json/gu)).toHaveLength(2);
    const twice = injectNegotiationRoutes(
      jsonOnly ?? "",
      ["/docs/a"],
      null,
      undefined,
      undefined,
      { json: true }
    );
    expect(twice).toBe(jsonOnly ?? "");
    const dropped = injectNegotiationRoutes(jsonOnly ?? "", ["/docs/a"]);
    expect(dropped).not.toContain("/404.json");
  });

  it("matches the JSON accept condition the way the Markdown one does", () => {
    const accept = new RegExp(ACCEPT_JSON_HEADER_VALUE, "u");
    expect(accept.test("application/json")).toBe(true);
    expect(accept.test("application/problem+json")).toBe(true);
    expect(accept.test("text/html, application/json;q=0.9")).toBe(true);
    expect(accept.test("application/json, text/plain")).toBe(true);
    expect(accept.test("*/*")).toBe(false);
    expect(accept.test("text/html,application/xhtml+xml")).toBe(false);
    expect(accept.test("application/jsonx")).toBe(false);
  });

  it("returns null when there is nowhere to splice", () => {
    expect(injectNegotiationRoutes("not json", ["/docs/a"])).toBeNull();
    expect(injectNegotiationRoutes("{}", ["/docs/a"])).toBeNull();
    expect(
      injectNegotiationRoutes(JSON.stringify({ routes: [{ src: "^/x$" }] }), [
        "/docs/a",
      ])
    ).toBeNull();
  });
});
