import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { withBasePath } from "../../core/base-path.ts";
import type { McpData } from "./data.ts";
import {
  createIndexProvider,
  getNavigation,
  getPageMarkdown,
  listPages,
  normalizeRoute,
  searchDocs,
  TOOL_INPUTS,
  urlFor,
} from "./query.ts";
import type { OramaIndexProvider } from "./query.ts";
import { MCP_TOOLS } from "./tools.ts";

export { createIndexProvider } from "./query.ts";
export type { OramaIndexProvider } from "./query.ts";

/**
 * The low-level SDK `Server` is used (rather than the high-level `McpServer`)
 * because the latter's `registerTool` is generic over the caller's Zod instance;
 * Blume's zod and the SDK's may resolve to different copies, whose types don't
 * unify. The operations themselves live in `query.ts`, shared with the JSON
 * docs API; this module is the MCP transport over them.
 */

/** Every page resource is the page's agent Markdown. */
const RESOURCE_MIME_TYPE = "text/markdown";
/** The MCP spec's JSON-RPC code for an unknown resource URI. */
const RESOURCE_NOT_FOUND = -32_002;
/** URI scheme for page resources when no `deployment.site` is configured. */
const LOCAL_RESOURCE_SCHEME = "blume:";

const CORS_HEADERS = {
  "Access-Control-Allow-Headers":
    "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const appendVaryOrigin = (headers: Headers): void => {
  const vary = headers.get("Vary");
  if (
    !vary
      ?.split(",")
      .some((value) => ["*", "origin"].includes(value.trim().toLowerCase()))
  ) {
    headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
  }
};

const corsHeaders = (headers: Headers, origin: string | null): Headers => {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  if (origin === null) {
    headers.delete("Access-Control-Allow-Origin");
  } else {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  // Originless responses must not be reused for a browser's same-origin request.
  appendVaryOrigin(headers);
  return headers;
};

/**
 * A tool's advertised JSON Schema. The dialect key is dropped (noise in a
 * tools/list payload), as is the root `additionalProperties: false` — the
 * runtime strips unknown keys rather than rejecting them, and the advertised
 * schema shouldn't promise stricter validation than the server performs.
 */
const inputSchemaFor = (schema: z.ZodType) => {
  const {
    $schema: _dialect,
    additionalProperties: _closed,
    ...rest
  } = z.toJSONSchema(schema);
  return rest;
};

/** The `tools/list` payload, derived from shared metadata + input schemas. */
const TOOL_DEFINITIONS = MCP_TOOLS.map((tool) => ({
  annotations: tool.annotations,
  description: tool.description,
  inputSchema: inputSchemaFor(
    // SAFETY: TOOL_INPUTS declares a schema for every MCP_TOOLS name; the two
    // lists are maintained together so names and descriptions never drift.
    TOOL_INPUTS[tool.name as keyof typeof TOOL_INPUTS]
  ),
  name: tool.name,
  title: tool.title,
}));

/** One `resources/list` entry: a page served as `text/markdown`. */
interface PageResource {
  description?: string;
  mimeType: string;
  name: string;
  title: string;
  uri: string;
}

/**
 * A page's resource URI. Resource URIs must be absolute, so this is the page's
 * served URL when a site is configured (the same URL `search_docs` and
 * `list_pages` emit, so an agent can hand either back to `resources/read`),
 * and a `blume:` URI carrying the based route otherwise.
 */
const resourceUri = (route: string, data: McpData): string =>
  data.site
    ? urlFor(route, data)
    : `${LOCAL_RESOURCE_SCHEME}${withBasePath(data.base, route)}`;

/** The `pages` key a resource URI (either form, or a bare route) names. */
const resourceRoute = (uri: string, data: McpData): string =>
  normalizeRoute(
    uri.startsWith(LOCAL_RESOURCE_SCHEME)
      ? uri.slice(LOCAL_RESOURCE_SCHEME.length)
      : uri,
    data
  );

/** A tool call's text result, marked as an error when `isError` is set. */
const text = (value: string, isError = false) => {
  const content = [{ text: value, type: "text" as const }];
  return isError ? { content, isError: true } : { content };
};

/** Construct a fresh MCP server with Blume's read-only docs tools registered. */
export const buildServer = (
  data: McpData,
  index: OramaIndexProvider
): Server => {
  const capabilities = { resources: {}, tools: {} };
  const serverOptions: ServerOptions = data.instructions
    ? { capabilities, instructions: data.instructions }
    : { capabilities };
  const server = new Server(
    { name: data.name, version: data.version },
    serverOptions
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // Every page doubles as a resource, so a client that attaches context by
  // URI (rather than calling tools) can browse and read the docs too. The
  // list is the same route set `list_pages` returns; reading one serves the
  // same agent Markdown `get_page` does.
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: data.routes.map((route) => {
      const resource: PageResource = {
        mimeType: RESOURCE_MIME_TYPE,
        name: route.title,
        title: route.title,
        uri: resourceUri(route.route, data),
      };
      if (route.description) {
        resource.description = route.description;
      }
      return resource;
    }),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const { uri } = request.params;
    const markdown = getPageMarkdown(data, resourceRoute(uri, data));
    if (markdown === undefined) {
      throw new McpError(
        RESOURCE_NOT_FOUND,
        `No page found at "${uri}". Use resources/list or list_pages to find valid URIs.`
      );
    }
    return {
      contents: [{ mimeType: RESOURCE_MIME_TYPE, text: markdown, uri }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { arguments: args = {}, name } = request.params;

    if (name === "search_docs") {
      const results = await searchDocs(
        data,
        index,
        TOOL_INPUTS.search_docs.parse(args)
      );
      return text(JSON.stringify(results, null, 2));
    }

    if (name === "get_page") {
      const input = TOOL_INPUTS.get_page.parse(args);
      const key = normalizeRoute(input.route, data);
      const markdown = getPageMarkdown(data, key);
      if (markdown === undefined) {
        return text(
          `No page found at "${key}". Use list_pages or search_docs to find valid routes.`,
          true
        );
      }
      return text(markdown);
    }

    if (name === "list_pages") {
      const listing = listPages(data, TOOL_INPUTS.list_pages.parse(args));
      return text(JSON.stringify(listing, null, 2));
    }

    if (name === "get_navigation") {
      const result = getNavigation(
        data,
        TOOL_INPUTS.get_navigation.parse(args)
      );
      if ("error" in result) {
        return text(result.error, true);
      }
      return text(JSON.stringify(result.navigation, null, 2));
    }

    return text(`Unknown tool: ${name}`, true);
  });

  return server;
};

/**
 * Build a stateless Streamable-HTTP MCP request handler from a data snapshot.
 *
 * The Orama index is built once and reused; a fresh `Server` and transport are
 * created per request (required by the SDK's stateless mode, which skips session
 * tracking). `enableJsonResponse` makes each call a plain request/response — no
 * SSE — which suits read-only docs tools and runs on any adapter (Node, Vercel,
 * Netlify, Cloudflare). Browser requests must originate from the endpoint's
 * own origin; non-browser clients can omit Origin.
 */
export const createMcpFetchHandler = (
  data: McpData
): ((request: Request) => Promise<Response>) => {
  const index = createIndexProvider(data.documents, data.defaultLocale);

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== new URL(request.url).origin) {
      return new Response("Forbidden", {
        headers: { Vary: "Origin" },
        status: 403,
      });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(new Headers(), origin),
        status: 204,
      });
    }
    if (request.method === "GET") {
      // No server-initiated streams are needed for read-only tools.
      return new Response("Method Not Allowed", {
        headers: corsHeaders(new Headers({ Allow: "POST, OPTIONS" }), origin),
        status: 405,
      });
    }

    const server = buildServer(data, index);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      // The SDK enables stateless mode only when this is `undefined`; `null` is
      // not an accepted value for the `(() => string) | undefined` option.
      // oxlint-disable-next-line sonarjs/no-undefined-assignment
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);

    const headers = corsHeaders(new Headers(response.headers), origin);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
};
