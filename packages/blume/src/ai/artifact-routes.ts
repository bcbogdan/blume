import { normalizeBasePath, prependRouteBase } from "../core/base-path.ts";

/** Only framework-owned artifacts move with content; well-known and explicit routes do not. */
export const artifactRoute = (basePath: string, path: string): string =>
  [
    "/llms.txt",
    "/llms-full.txt",
    "/agent-readability.json",
    "/openapi.json",
    "/api/docs",
  ].includes(path) || path.startsWith("/api/docs/")
    ? prependRouteBase(basePath, path)
    : path;

/** Public path for a generated artifact; deployment and content mounts are independent. */
export const deployedArtifactRoute = (
  deploymentBase: string,
  contentBase: string,
  path: string
): string =>
  prependRouteBase(
    normalizeBasePath(deploymentBase),
    artifactRoute(contentBase, path)
  );
