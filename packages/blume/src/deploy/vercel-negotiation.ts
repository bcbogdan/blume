/**
 * `Accept: text/markdown` content negotiation for Vercel server builds.
 *
 * Blume prerenders every content page — even under `deployment.output:
 * "server"` — so a page request never reaches Astro middleware: Vercel serves
 * the prerendered HTML straight from its static layer. Request-time negotiation
 * therefore has to live in the platform's routing config. The Vercel adapter
 * emits a Build Output API `config.json`; these helpers splice extra routes
 * into it so a content-page request that prefers `text/markdown` is rewritten
 * (not redirected) to the page's prerendered `.md` mirror — the deployed
 * counterpart of the dev-server rewrite in `astro/markdown-negotiation.ts`.
 * The same routing config also answers a *missing* page: a request that
 * prefers Markdown (or asks for a `.md` URL no page backs) gets the
 * prerendered Markdown 404 body with the 404 status, instead of the HTML
 * shell, and one that prefers JSON (or asks for a `.json` URL) gets the
 * prerendered problem-details 404.
 */

/**
 * Regex for the `accept` header condition. Written to hold under both matching
 * semantics a router may apply — full-string and substring — by anchoring the
 * end and letting `(.*,)?` absorb any earlier list entries: it requires a
 * `text/markdown` or `text/x-markdown` entry terminated by `;`, `,`, or the end
 * of the header. Kept lookaround-free so it stays valid in RE2, and lowercase
 * only — real agents send lowercase media types, and q-values are not compared
 * (a client sending `text/markdown` at `q=0` is pathological). Browsers never
 * send `text/markdown`, so ordinary page requests are unaffected.
 */
export const ACCEPT_MARKDOWN_HEADER_VALUE =
  "(.*,)?\\s*text/(x-)?markdown(\\s*[;,].*)?$";

/**
 * The JSON counterpart, for the problem-details 404: `application/json` or
 * `application/problem+json`. Browsers never send either on a navigation
 * (the catch-all wildcard does not match), so ordinary page requests are
 * unaffected.
 */
export const ACCEPT_JSON_HEADER_VALUE =
  "(.*,)?\\s*application/(problem\\+)?json(\\s*[;,].*)?$";

/**
 * A Build Output API route — the subset these helpers read and write. Parsed
 * routes keep whatever other fields they carry at runtime; only these are
 * typed.
 */
export interface VercelRoute {
  continue?: boolean;
  dest?: string;
  handle?: string;
  has?: { key?: string; type: string; value?: string }[];
  headers?: Record<string, string>;
  src?: string;
  status?: number;
}

/** Whether a parsed route field is a real string (the config is raw JSON). */
const isString = (value: string | undefined): value is string =>
  typeof value === "string";

const ACCEPT_MARKDOWN_CONDITION: VercelRoute["has"] = [
  { key: "accept", type: "header", value: ACCEPT_MARKDOWN_HEADER_VALUE },
];

const ACCEPT_JSON_CONDITION: VercelRoute["has"] = [
  { key: "accept", type: "header", value: ACCEPT_JSON_HEADER_VALUE },
];

const VARY_ACCEPT = { vary: "Accept" };

/** Where the prerendered Markdown 404 (`pages/404.md.ts`) lands. */
const NOT_FOUND_MARKDOWN_DEST = "/404.md";

/** Where the prerendered JSON 404 (`pages/404.json.ts`) lands. */
const NOT_FOUND_JSON_DEST = "/404.json";

/** The adapter's own not-found fallback — the anchor the Markdown 404 precedes. */
const NOT_FOUND_HTML_DEST = "/404.html";

/**
 * Miss-phase routes that answer a missing page with the Markdown 404 body: any
 * path when the client prefers Markdown, and any `.md`/`.mdx` URL (a request
 * for a raw-Markdown mirror that has no page wants Markdown back, not the HTML
 * shell). Both keep the 404 status. Spliced immediately before the adapter's
 * `/404.html` fallback, so they run after every server route (the MCP
 * endpoint, server islands, images) has had its turn and never hijack a
 * request one of those would have answered.
 */
const NOT_FOUND_MARKDOWN_ROUTES: readonly VercelRoute[] = [
  {
    dest: NOT_FOUND_MARKDOWN_DEST,
    has: ACCEPT_MARKDOWN_CONDITION,
    headers: VARY_ACCEPT,
    src: "^/.*$",
    status: 404,
  },
  { dest: NOT_FOUND_MARKDOWN_DEST, src: "^/.*\\.mdx?$", status: 404 },
];

/**
 * The JSON 404's miss-phase routes, the problem-details twin of the Markdown
 * ones: any path when the client prefers JSON, and any `.json` URL no file
 * backs. Spliced at the same anchor, after every server route — so the
 * `/api/` catch-all (which answers its own namespace with a problem document)
 * has already had its turn.
 */
const NOT_FOUND_JSON_ROUTES: readonly VercelRoute[] = [
  {
    dest: NOT_FOUND_JSON_DEST,
    has: ACCEPT_JSON_CONDITION,
    headers: VARY_ACCEPT,
    src: "^/.*$",
    status: 404,
  },
  { dest: NOT_FOUND_JSON_DEST, src: "^/.*\\.json$", status: 404 },
];

/** Which prerendered 404 twins the build emitted, so their routes get wired. */
export interface NotFoundVariants {
  json?: boolean;
  markdown?: boolean;
}

/**
 * Vercel rejects route `src` patterns longer than 4096 characters, so route
 * alternations are split across as many route entries as needed. The budget
 * leaves headroom for the `^(` … `)/?$` wrapper.
 */
const MAX_ALTERNATION_LENGTH = 3900;

const REGEX_SPECIALS = /[$()*+.?[\]^{|}\\]/gu;

/**
 * A route path as it appears on the wire (percent-encoded, matching the layout
 * of the prerendered files), escaped for literal use inside the alternation.
 * Escaping runs after encoding; the `%` an encode introduces is not a regex
 * metacharacter.
 */
const routePattern = (route: string): string =>
  encodeURI(route).replace(REGEX_SPECIALS, "\\$&");

/** Group patterns so each group's alternation stays under the `src` limit. */
const chunkPatterns = (patterns: readonly string[]): string[][] => {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const pattern of patterns) {
    if (
      current.length > 0 &&
      length + pattern.length + 1 > MAX_ALTERNATION_LENGTH
    ) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(pattern);
    length += pattern.length + 1;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

export interface NegotiationRoutes {
  /**
   * `Vary: Accept` for the plain-HTML side of every negotiated URL, so shared
   * caches keep the two variants apart. Spliced *before* `handle:
   * "filesystem"` with `continue`: main-phase headers accumulate and ride on
   * whatever ultimately serves the request. Routes placed after the filesystem
   * marker are the miss phase — they run only when no static file matches, and
   * every Blume content page is a prerendered static file, so a header route
   * there never fires.
   */
  headerRoutes: VercelRoute[];
  /**
   * The negotiation itself: header-conditional rewrites to the `.md` mirror.
   * Spliced *before* `handle: "filesystem"` so they run ahead of static-file
   * matching; the rewritten path then resolves to the prerendered `.md` file.
   */
  rewriteRoutes: VercelRoute[];
}

/**
 * Build the routes for the given content-route paths (the routes that have a
 * raw-Markdown mirror, straight from the manifest). Paths are matched with an
 * optional trailing slash and rewritten `/{route}` → `/{route}.md`; the home
 * page's mirror lives at `/index.md`. When `homeTokens` is given, the home
 * rewrite also stamps `x-markdown-tokens` — the estimated token count of the
 * homepage mirror (Cloudflare's Markdown for Agents convention). Only the home
 * route can carry it: the other rewrites are chunked alternations spanning
 * many pages, and a count is per-page.
 */
export const buildNegotiationRoutes = (
  routePaths: readonly string[],
  homeTokens?: number
): NegotiationRoutes => {
  const home = routePaths.includes("/");
  const rest = routePaths
    .filter((path) => path !== "/")
    .map((path) => routePattern(path));
  const chunks = chunkPatterns(rest);

  const rewriteRoutes: VercelRoute[] = home
    ? [
        {
          dest: "/index.md",
          has: ACCEPT_MARKDOWN_CONDITION,
          headers:
            homeTokens === undefined
              ? VARY_ACCEPT
              : { ...VARY_ACCEPT, "x-markdown-tokens": String(homeTokens) },
          src: "^/$",
        },
      ]
    : [];
  for (const chunk of chunks) {
    rewriteRoutes.push({
      dest: "$1.md",
      has: ACCEPT_MARKDOWN_CONDITION,
      headers: VARY_ACCEPT,
      src: `^(${chunk.join("|")})/?$`,
    });
  }

  const headerChunks = chunkPatterns(home ? ["/", ...rest] : rest);
  const headerRoutes: VercelRoute[] = headerChunks.map((chunk) => ({
    continue: true,
    headers: VARY_ACCEPT,
    src: `^(?:${chunk.join("|")})/?$`,
  }));

  return { headerRoutes, rewriteRoutes };
};

/** The `src` of the injected homepage `Link` header route. */
const HOME_SRC = "^/$";

/**
 * Permanent redirect from any trailing-slash URL to its slashless twin, so
 * `/docs/` and `/docs` don't serve as duplicate URLs (canonicals, sitemap, and
 * hreflang all use the slashless form; the root `/` is untouched — `.+`
 * requires a non-empty path). Spliced into the main phase before `handle:
 * "filesystem"`, after the Markdown rewrites, so an agent's `Accept:
 * text/markdown` request on a slashed URL still rewrites without the extra
 * hop. Vercel carries the query string over to the `Location` target itself.
 */
export const TRAILING_SLASH_REDIRECT: VercelRoute = {
  headers: { Location: "/$1" },
  src: "^/(.+)/$",
  status: 308,
};

/**
 * Whether a route is one this module previously injected, so re-injection
 * replaces rather than duplicates. Rewrites are identified by their `accept`
 * condition; the `Vary` routes by their exact three-field shape (a
 * user-authored route of that identical shape would be semantically equal to
 * the one re-added); the homepage `Link` route by its three-field
 * continue-with-link shape (the Build Output config is adapter-generated, so
 * no user-authored route competes in this file); the Markdown 404 routes by
 * their `/404.md` destination.
 */
const isNegotiationRoute = (route: VercelRoute): boolean =>
  route.has?.some(
    (condition) => condition.value === ACCEPT_MARKDOWN_HEADER_VALUE
  ) === true ||
  (route.dest === NOT_FOUND_MARKDOWN_DEST && route.status === 404) ||
  (route.dest === NOT_FOUND_JSON_DEST && route.status === 404) ||
  (route.continue === true &&
    route.headers?.vary === "Accept" &&
    isString(route.src) &&
    Object.keys(route).length === 3) ||
  (route.continue === true &&
    isString(route.headers?.link) &&
    route.src === HOME_SRC &&
    Object.keys(route).length === 3) ||
  (route.status === TRAILING_SLASH_REDIRECT.status &&
    route.src === TRAILING_SLASH_REDIRECT.src);

const isPlainRedirect = (route: VercelRoute): boolean =>
  isString(route.src) &&
  [301, 302, 303, 307, 308].includes(route.status ?? 0) &&
  isString(route.headers?.Location) &&
  Object.keys(route.headers).length === 1 &&
  Object.keys(route).length === 3;

const isPlainHeaderRoute = (route: VercelRoute): boolean =>
  route.continue === true &&
  isString(route.src) &&
  route.headers !== undefined &&
  Object.keys(route).length === 3;

// Only literal paths, optionally ending in /?. Captures and other regex syntax
// need a language-containment proof, which this optimization deliberately avoids.
const LITERAL_REDIRECT_SRC = /^\^\/[\w/-]*(?:\/\?)?\$$/u;

/**
 * Drop only an unreachable adapter-shaped fallback. Never widen a main-phase
 * redirect: even an added slash can steal a filesystem match or a later route.
 * Identical literal patterns need no overlap analysis. The prefix must contain
 * only terminal redirects, headers, and one filesystem marker; a rewrite or
 * unknown field could change the path before it reaches the fallback.
 */
const deduplicateRedirectRoutes = (routes: VercelRoute[]): VercelRoute[] => {
  const filesystemIndices = routes.flatMap((route, index) =>
    route.handle === "filesystem" ? [index] : []
  );
  const [filesystemIndex] = filesystemIndices;
  if (filesystemIndex === undefined || filesystemIndices.length !== 1) {
    return routes;
  }
  const direct = routes.slice(0, filesystemIndex);
  const redirectSources = direct
    .filter(isPlainRedirect)
    .map((route) => route.src);
  let safePrefix = true;
  return routes.filter((route, index) => {
    if (
      safePrefix &&
      index > filesystemIndex &&
      route.dest === "_render" &&
      isString(route.src) &&
      LITERAL_REDIRECT_SRC.test(route.src) &&
      Object.keys(route).length === 2 &&
      redirectSources.filter((src) => src === route.src).length === 1 &&
      routes.filter(
        (candidate) =>
          candidate.src === route.src && candidate.dest === "_render"
      ).length === 1
    ) {
      return false;
    }
    safePrefix &&=
      isPlainRedirect(route) ||
      isPlainHeaderRoute(route) ||
      (index === filesystemIndex && Object.keys(route).length === 1);
    return true;
  });
};

/**
 * Splice the negotiation routes into a Build Output `config.json`, plus — when
 * given — a homepage `Link` header route for agent discovery (see
 * `ai/link-headers.ts`), applied the same way the `Vary` routes are: in the
 * main phase before `handle: "filesystem"` with `continue`, so the header
 * rides on the prerendered homepage response. `contentTypeOverrides` maps static-dir
 * relative paths to media types via the Build Output `overrides` field — the
 * platform's mechanism for extensionless static files (e.g. the Web Bot Auth
 * signature directory). The trailing-slash 308 redirect is always spliced in
 * alongside, so slashed duplicates of every page collapse onto the canonical
 * slashless URL. For each 404 twin the build emitted (`notFound.markdown` for
 * `404.md`, `notFound.json` for `404.json`), its routes go into the miss
 * phase right before the adapter's `/404.html` fallback — and nowhere when
 * that fallback is absent, since a `dest` with no file behind it would serve
 * nothing. Returns the updated JSON
 * text (tab-indented, like the adapter's own output), or `null` when there is
 * nowhere safe to splice: an unparsable config, no `routes` array, or no
 * `handle: "filesystem"` marker to anchor the splice.
 */
export const injectNegotiationRoutes = (
  configText: string,
  routePaths: readonly string[],
  homeLinkHeader?: string | null,
  contentTypeOverrides?: Record<string, string>,
  homeTokens?: number,
  notFound: NotFoundVariants = {}
): string | null => {
  const overrideEntries = Object.entries(contentTypeOverrides ?? {});
  let config: {
    overrides?: Record<string, { contentType?: string; path?: string }>;
    routes?: VercelRoute[];
  };
  try {
    config = JSON.parse(configText);
  } catch {
    return null;
  }
  if (!Array.isArray(config.routes)) {
    return null;
  }
  for (const [path, contentType] of overrideEntries) {
    // Keyed assignment, so re-injection replaces rather than duplicates and a
    // user's own override of the same path is simply refreshed.
    config.overrides = { ...config.overrides, [path]: { contentType } };
  }
  const routes = deduplicateRedirectRoutes(
    config.routes.filter((route) => !isNegotiationRoute(route))
  );
  const filesystemIndex = routes.findIndex(
    (route) => route.handle === "filesystem"
  );
  if (filesystemIndex === -1) {
    return null;
  }
  const { headerRoutes, rewriteRoutes } = buildNegotiationRoutes(
    routePaths,
    homeTokens
  );
  if (homeLinkHeader) {
    headerRoutes.push({
      continue: true,
      headers: { link: homeLinkHeader },
      src: HOME_SRC,
    });
  }
  // Headers first: `continue` routes accumulate, so a request the rewrite
  // route then terminates (Markdown negotiation on the homepage) still carries
  // the Link header. The trailing-slash redirect goes last so a slashed URL's
  // Markdown negotiation still rewrites directly instead of bouncing.
  routes.splice(
    filesystemIndex,
    0,
    ...headerRoutes,
    ...rewriteRoutes,
    TRAILING_SLASH_REDIRECT
  );
  const notFoundRoutes = [
    ...(notFound.markdown ? NOT_FOUND_MARKDOWN_ROUTES : []),
    ...(notFound.json ? NOT_FOUND_JSON_ROUTES : []),
  ];
  if (notFoundRoutes.length > 0) {
    const fallbackIndex = routes.findIndex(
      (route) => route.status === 404 && route.dest === NOT_FOUND_HTML_DEST
    );
    if (fallbackIndex !== -1) {
      routes.splice(fallbackIndex, 0, ...notFoundRoutes);
    }
  }
  config.routes = routes;
  return `${JSON.stringify(config, null, "\t")}\n`;
};
