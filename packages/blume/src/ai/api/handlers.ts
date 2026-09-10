import { prependRouteBase } from "../../core/base-path.ts";
import { absoluteUrl } from "../../core/site-url.ts";
import type { Navigation } from "../../core/types.ts";
import { artifactRoute } from "../artifact-routes.ts";
import type { McpData, McpRoute } from "../mcp/data.ts";
import {
  createIndexProvider,
  getPageMarkdown,
  searchDocs,
  TOOL_INPUTS,
  urlFor,
} from "../mcp/query.ts";
import type { SearchHitPayload } from "../mcp/query.ts";
import {
  API_BASE,
  API_PAGES_PATH,
  API_SEARCH_PATH,
  OPENAPI_PATH,
} from "./paths.ts";
import { problemResponse } from "./problem.ts";

/**
 * The JSON docs API: the REST twin of the MCP tools, over the same snapshot
 * and the same operations (`mcp/query.ts`). The page index, per-page JSON,
 * and navigation are prerendered, so a static site serves them from files;
 * search is a live endpoint and exists on server output only. Errors are RFC
 * 9457 problem details (`problem.ts`). The generated endpoints under
 * `.blume/src/pages/api/docs/` are thin wrappers around these.
 */

/** One page in the index; `version` only appears on versioned sites. */
export interface ApiPageSummary {
  contentType: string;
  description?: string;
  facets?: Record<string, string>;
  /** The page's JSON representation (this API's `getPage`). */
  json: string;
  lastModified: string | null;
  locale: string;
  /** The page's raw-Markdown mirror (`{route}.md`). */
  markdownUrl: string;
  route: string;
  title: string;
  /** Where the rendered page is served. */
  url: string;
  version?: string;
}

/** The `pages.json` document. */
export interface ApiPagesIndex {
  count: number;
  generator: string;
  pages: ApiPageSummary[];
  site: string | null;
}

/** A page's JSON representation: its index entry plus the agent Markdown. */
export interface ApiPage extends ApiPageSummary {
  markdown: string;
}

/** The search endpoint's document. */
export interface ApiSearchResponse {
  count: number;
  query: string;
  results: SearchHitPayload[];
}

/** The site + base an endpoint needs to build absolute URLs. */
export interface ApiSiteContext {
  base: string;
  contentBase?: string;
  site: string | null;
}

/** What the API serializes: one of its documents, or the navigation tree. */
export type ApiPayload =
  | ApiPage
  | ApiPagesIndex
  | ApiSearchResponse
  | Navigation;

/** A `Response` carrying JSON, pretty-printed for the humans who curl it. */
export const jsonResponse = (payload: ApiPayload, status = 200): Response =>
  new Response(`${JSON.stringify(payload, null, 2)}\n`, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
    status,
  });

/** The `pages/{route}.json` path segment for a route (`index` for home). */
export const pageParam = (route: string): string =>
  route === "/" ? "index" : route.slice(1);

/** The absolute (or root-relative) URL for a base-less path. */
const siteUrl = (path: string, context: ApiSiteContext): string => {
  const based = prependRouteBase(context.base, path);
  return context.site ? absoluteUrl(context.site, based) : based;
};

const apiUrl = (path: string, context: ApiSiteContext): string =>
  siteUrl(artifactRoute(context.contentBase ?? "", path), context);

const summarize = (route: McpRoute, data: McpData): ApiPageSummary => {
  const summary: ApiPageSummary = {
    contentType: route.contentType,
    json: apiUrl(`${API_BASE}/pages/${pageParam(route.route)}.json`, data),
    lastModified: route.lastModified,
    locale: route.locale,
    markdownUrl: siteUrl(`/${pageParam(route.route)}.md`, data),
    route: route.route,
    title: route.title,
    url: urlFor(route.route, data),
  };
  if (route.description !== undefined) {
    summary.description = route.description;
  }
  if (route.facets) {
    summary.facets = route.facets;
  }
  if (data.archivedVersions) {
    summary.version = route.version;
  }
  return summary;
};

/** Every non-hidden page, in manifest order; the index is unfiltered. */
export const buildPagesIndex = (data: McpData): ApiPagesIndex => {
  const pages = data.routes.map((route) => summarize(route, data));
  return {
    count: pages.length,
    generator: `blume@${data.version}`,
    pages,
    site: data.site,
  };
};

export const pagesIndexResponse = (data: McpData): Response =>
  jsonResponse(buildPagesIndex(data));

/**
 * `getStaticPaths` entries for the per-page endpoint: one per route that has
 * agent Markdown to serve (a landing page without a mirror has no JSON twin
 * either).
 */
export const pageParams = (
  data: McpData
): { params: { route: string }; props: { route: string } }[] =>
  data.routes
    .filter((route) => getPageMarkdown(data, route.route) !== undefined)
    .map((route) => ({
      params: { route: pageParam(route.route) },
      props: { route: route.route },
    }));

/** A page's JSON document, or null when no page has the route. */
export const buildPage = (data: McpData, route: string): ApiPage | null => {
  const entry = data.routes.find((candidate) => candidate.route === route);
  const markdown = getPageMarkdown(data, route);
  if (!entry || markdown === undefined) {
    return null;
  }
  return { ...summarize(entry, data), markdown };
};

export const pageResponse = (data: McpData, route: string): Response => {
  const page = buildPage(data, route);
  if (!page) {
    return problemResponse({
      code: "PAGE_NOT_FOUND",
      detail: `No documentation page has the route "${route}".`,
      instance: apiUrl(`${API_BASE}/pages/${pageParam(route)}.json`, data),
      resolution: `List every page at ${apiUrl(API_PAGES_PATH, data)}, or discover the API through ${apiUrl(OPENAPI_PATH, data)}.`,
      status: 404,
      title: "Page not found",
    });
  }
  return jsonResponse(page);
};

/** The default navigation tree (default locale, current docs). */
export const buildNavigation = (data: McpData): Navigation => data.navigation;

export const navigationResponse = (data: McpData): Response =>
  jsonResponse(buildNavigation(data));

/** Repeated and comma-separated values of a list query parameter. */
const listParam = (
  params: URLSearchParams,
  key: string
): string[] | undefined => {
  const values = params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
};

const FILTER_PARAM = /^filters\[(?<key>.+)\]$/u;

/** The `filters[key]=value` (OpenAPI deepObject) facet filters. */
const filtersParam = (
  params: URLSearchParams
): Record<string, string> | undefined => {
  const entries: [string, string][] = [];
  for (const [key, value] of params) {
    const facet = FILTER_PARAM.exec(key)?.groups?.key;
    if (facet) {
      entries.push([facet, value]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/**
 * The live search endpoint: `GET /api/docs/search?q=…`. Runs the same query
 * `search_docs` runs, over an index built once per snapshot and shared across
 * requests. A missing or blank `q` is a 400 problem.
 */
export const createSearchHandler = (
  data: McpData
): ((request: Request) => Promise<Response>) => {
  const index = createIndexProvider(data.documents, data.defaultLocale);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const params = url.searchParams;
    const query = (params.get("q") ?? "").trim();
    if (!query) {
      return problemResponse({
        code: "MISSING_QUERY",
        detail: 'The "q" query parameter is required and must not be blank.',
        instance: url.pathname,
        resolution: `Repeat the request with ?q=<search terms>, e.g. ${apiUrl(API_SEARCH_PATH, data)}?q=install.`,
        status: 400,
        title: "Missing search query",
      });
    }
    const input = TOOL_INPUTS.search_docs.parse({
      contentTypes: listParam(params, "contentTypes"),
      filters: filtersParam(params),
      limit: params.get("limit") ?? undefined,
      locale: params.get("locale") ?? undefined,
      query,
      version: params.get("version") ?? undefined,
    });
    const results = await searchDocs(data, index, input);
    const payload: ApiSearchResponse = {
      count: results.length,
      query,
      results,
    };
    return jsonResponse(payload);
  };
};

/**
 * The 404 for anything under `/api/` that no endpoint answers — the catch-all
 * behind every live route on server output, so an agent probing the API
 * namespace gets a problem document instead of the HTML not-found page.
 */
export const apiNotFoundResponse = (
  request: Request,
  context: ApiSiteContext
): Response => {
  const { pathname } = new URL(request.url);
  return problemResponse({
    code: "API_ROUTE_NOT_FOUND",
    detail: `No API route exists at ${pathname}.`,
    instance: pathname,
    links: [
      { href: apiUrl(OPENAPI_PATH, context), label: "OpenAPI description" },
      { href: apiUrl(API_PAGES_PATH, context), label: "Page index" },
    ],
    resolution: `Discover the available operations through the OpenAPI description at ${apiUrl(OPENAPI_PATH, context)}, or list every page at ${apiUrl(API_PAGES_PATH, context)}.`,
    status: 404,
    title: "API route not found",
  });
};
