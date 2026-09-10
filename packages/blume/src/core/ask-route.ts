import { normalizeBasePath, prependRouteBase } from "./base-path.ts";
import type { ResolvedConfig } from "./schema.ts";

/** Public client URL; explicit endpoints are already public URLs. */
export const askEndpoint = (config: ResolvedConfig): string =>
  config.ai.ask?.endpoint ??
  prependRouteBase(
    normalizeBasePath(config.deployment.base),
    prependRouteBase(config.basePath, "/api/ask")
  );
