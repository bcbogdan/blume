# SuperTokens patch port

## Purpose

Replace SuperTokens' `patch-package` changes to Blume 1.5.3 with maintained, independently reviewable source changes on Blume 1.6.4. Preserve zero-config behavior, support eject, and keep generic framework improvements suitable for upstream contribution. Generated CLI bundles and declarations come from the build; they are not hand-patched.

The source inventory is `supertokens/docs/patches/blume+1.5.3.patch` and commits `8875c6a81`, `8461592bb`, `2f2ff2a09`, `b3fd51bea`, `f122beeed`, `54d20c51b`, and `26c9c0069`. The fork baseline is `9e811a01` (`blume@1.6.4`).

## Deployment contract

SuperTokens mounts content at `/docs`, owns public files at `/docs-assets`, emits bundles under `/docs-assets/_astro`, and exposes Ask at `/docs/api/ask` and MCP at `/docs/mcp`. The parent application owns root MCP discovery. Public assets are physically stored under `public/docs-assets`; arbitrary authored asset URLs are not rewritten. Existing reverse-proxy aliases for machine-readable files must remain compatible.

`basePath` and Astro's `deployment.base` are separate layers. Generated page filenames include the former; Astro applies the latter. Explicit external endpoints remain external. Already-prefixed routes must not gain duplicate segments. Framework-owned artifacts advertised below the content mount must actually be served there, including in development and eject; merely changing links and depending on undocumented reverse-proxy rewrites is insufficient. Root well-known resources retain their protocol-specific ownership. The newer JSON docs API must be accounted for explicitly alongside other generated APIs.

## Independent concerns

### Ask endpoint routing

Generate the built-in Ask endpoint below `basePath`, compose its public client and manifest URL with `deployment.base`, and preserve explicit endpoint overrides. Apply the same behavior to eject and stale generated-file cleanup. Keep 1.6.4's `blume:ask-data` virtual module; do not port the obsolete relative JSON import workaround. Test root, nested, composed, external, disabled, and Inkeep cases.

### Public asset namespace

Add optional normalized `publicAssetBasePath`. It selects the conventional icon directory beneath `public` and sets generated bundle output to `<prefix>/_astro`. Empty configuration preserves existing behavior. Retain favicon variants, Apple icons, inline and bundled fallbacks, deployment-base composition, and authored URLs. Document the physical-directory requirement.

### Vite plugins

Add `vite.plugins` with suitable plugin-option typing. Load plugin objects through the existing config bridge, including plugins-only configurations, and append them after built-ins in user order. Preserve functions, restart behavior, and eject. Do not add the SuperTokens microfrontend plugin as a framework dependency.

### Optional MCP discovery

Add `ai.mcp.discovery`, defaulting to true. False disables both generated discovery documents and their advertisement without disabling MCP tools or the configured endpoint. Cover generation, regeneration, eject, manifests, llms text, catalogs, and JSON API descriptions. Preserve user-owned discovery files.

### Machine-readable routes

Make public URLs and generated artifact routes agree under a content mount. Distinguish based content, framework API routes, root artifacts, and explicit MCP routes. Use shared route helpers rather than blanket string concatenation. Keep root compatibility where needed and avoid stealing parent-owned well-known routes. Test site/no-site, deployment/content bases, actual served files, headers, HTML discovery, llms resources, JSON API, and external endpoints. Record any additional public configuration needed to resolve routing ownership before implementing it.

Ordinary framework artifacts (`llms.txt`, `llms-full.txt`, `agent-readability.json`, `openapi.json`, and `/api/docs/*`) gain content-mount routes while retaining root compatibility routes. Their advertisements use the mounted route. Protocol well-known resources and explicit MCP routes retain their existing root/deployment ownership; they are never blindly content-prefixed. No additional public routing configuration is needed.

### MCP Origin validation

Accept requests without Origin and requests whose Origin exactly matches the request URL origin; reject other origins before transport processing. Reflect accepted origins instead of wildcard CORS, preserve protocol headers, and vary responses by Origin, including originless responses. Preserve existing Vary tokens and `*`. Do not trust forwarded headers or add a configurable allowlist in this port. Test preflight, GET, valid initialize, malformed origins, and preview origins.

### Borderless Frame

Add `borderless`, default false, removing border, background, padding, and rounding while retaining media sizing, centering, captions, hints, and media behavior.

### Fence option metadata

Parse quoted `option` metadata into opaque `data-code-option`. Keep selection policy downstream. Reject embedded lookalikes, invalid or empty attributes, and preserve title, line-number, and other fence metadata behavior.

### Stable code-group identities

Preserve the existing downstream `tabValues` JSON mapping contract while validating its shape and own properties. Group direct fences by canonical value in first-seen order, preserve direct fence children and metadata, and expose invalid mappings without crashing. Explicit Tab panels and unmapped groups keep existing behavior. Preserve nested ownership, sync keys, accessibility, URL state, and reconnection. For multi-surface panels retain per-block copying rather than copying a hidden first alternative through the shared header button. Test navigation and copying.

### Vercel redirect deduplication

Collapse only proven adapter-generated direct-redirect/fallback pairs. Preserve captures, locations, statuses, ordering, filesystem precedence, negotiation, and 404 behavior. Leave ambiguous or conflicting cases untouched; do not implement a general regex-overlap engine. Test actual adapter output, slash-specific conflicts, extra route fields, duplicate pairs, and idempotence. This may belong upstream in Astro's Vercel adapter rather than Blume.

The port removes only identical literal-pattern fallbacks already covered by an unconditional redirect. It deliberately does not broaden slash matching as the original patch did: that can steal slash-specific routes or filesystem matches. Consequently this optimization may remove fewer routes than the original patch.

### Ask retrieval

Normalize conversational query noise locally without changing shared search or destroying meaningful multilingual/single-character tokens. Preserve locale and current-page behavior. In a separate change, retain bounded introductory context beside deep relevant excerpts, using real window position rather than a leading ellipsis heuristic. Account for separators, Unicode normalization, tight budgets, overlap, and short pages. Port the two SuperTokens grounding regressions and expand coverage for these boundaries; avoid a broader retrieval redesign.

## Omitted patch

Defer `highlightCode({ meta })`: no current SuperTokens caller was found. Retain it only if a concrete dependency is discovered and document title precedence first. SuperTokens selection controllers, technology mappings, prompts, model choices, legacy redirect data, and deployment configuration remain in the application.

## Delivery and validation

Write this specification before implementation. Delegate disjoint file ownership to implementation agents and serialize routing/config changes sharing generation, schema, and template files. Independent reviewers check each concern against this contract. Each user-facing implementation commit includes a Changeset and canonical documentation where applicable. Work on existing main; do not push or publish.

Run focused tests during implementation, then `bun run check`, `bun run typecheck`, `bun run test:coverage`, and `bun run build`. Meet the repository's per-file coverage gate. Verify relevant browser behavior and a clean packed-package consumer so source tests cannot hide missing CLI/type/package output. Run pre-commit hooks; never bypass them. Record concrete validation limitations rather than claiming unrun checks passed. Commit only intended files, with one concern per commit where shared compatibility fixes do not require an atomic change.

## Validation findings

The reviewed port passes the workspace checks, typechecks, builds, and all 3,468 coverage tests with 100% line/function coverage. The Chromium component/site suite passes 21 tests. Tests also exercise generated and ejected applications in development and production, including advertised artifact links. Local validation uses Bun 1.3.14; the repository's Bun 1.4.0 pin is unchanged.

A clean npm-installed packed consumer verifies CLI execution, declaration resolution, plugin hooks, asset namespaces, components, and mounted endpoints. Its production probe exposed an upstream Astro limitation: when `deployment.base` overlaps `basePath`, Astro can strip the deployment base twice while routing dynamic endpoints. A minimal Astro application without Blume reproduces this with Astro 7.3.2 and Node adapters 11.0.0, 11.0.3, and 11.1.5; Astro 7.1.5 with adapter 11.0.3 also reproduces it. The intended SuperTokens configuration (content base `/docs`, no deployment base) and distinct `/host` + `/docs` bases serve Ask and MCP correctly. Keep correct independent URL composition in Blume; do not add an adapter-specific rewrite to compensate for upstream double-stripping.

Packed consumer typechecking uses `skipLibCheck: true`: disabling it exposes dependency declaration errors in Astro, Vercel WebSocket types, and optional unstorage drivers. No dependency or engine changes are included in this port.
