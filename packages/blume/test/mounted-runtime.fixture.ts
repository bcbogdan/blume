import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";

import { build, dev, preview } from "astro";
import { join } from "pathe";

import type { AgentReadabilityManifest } from "../src/ai/agent-readability.ts";
import type { ApiPage, ApiPagesIndex } from "../src/ai/api/handlers.ts";
import type { ApiSpecDocument } from "../src/ai/api/spec.ts";
import { generateRuntime } from "../src/astro/generate.ts";
import { packageRoot } from "../src/core/package-root.ts";
import { scanProject } from "../src/core/project-graph.ts";
import { eject } from "../src/registry/eject.ts";

const probe = async (root: string, base: string): Promise<void> => {
  const server = await dev({
    configFile: "astro.config.mjs",
    logLevel: "error",
    root,
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    const origin = `http://127.0.0.1:${server.address.port}`;
    const mount = `${base}/docs`;
    const get = async (path: string, mime: string): Promise<Response> => {
      const response = await fetch(new URL(path, origin), {
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200, path);
      assert.ok(
        response.headers.get("content-type")?.startsWith(mime),
        `${path}: ${response.headers.get("content-type")}`
      );
      return response;
    };
    const indexResponse = await get(
      `${mount}/api/docs/pages.json`,
      "application/json"
    );
    const index: ApiPagesIndex = await indexResponse.json();
    assert.equal(index.count, 1);
    const [entry] = index.pages;
    assert.ok(entry);
    assert.equal(entry.json, `${mount}/api/docs/pages/docs.json`);
    assert.equal(entry.url, mount);
    assert.equal(entry.markdownUrl, `${mount}.md`);
    const pageResponse = await get(entry.json, "application/json");
    const page: ApiPage = await pageResponse.json();
    assert.equal(page.json, entry.json);
    assert.match(page.markdown, /Hello docs/u);
    const markdownResponse = await get(entry.markdownUrl, "text/markdown");
    assert.match(await markdownResponse.text(), /Hello docs/u);
    const manifestResponse = await get(
      `${mount}/agent-readability.json`,
      "application/json"
    );
    const manifest: AgentReadabilityManifest = await manifestResponse.json();
    assert.equal(manifest.artifacts.api?.pages, `${mount}/api/docs/pages.json`);
    assert.equal(manifest.artifacts.llmsTxt, `${mount}/llms.txt`);
    const llmsResponse = await get(`${mount}/llms.txt`, "text/plain");
    const llmsText = await llmsResponse.text();
    assert.ok(llmsText.includes(`${mount}/api/docs/pages.json`));
    const catalogResponse = await get(
      `${base}/.well-known/api-catalog`,
      "application/linkset+json"
    );
    const catalog: {
      linkset: { anchor: string; "service-doc": { href: string }[] }[];
    } = await catalogResponse.json();
    assert.equal(catalog.linkset[0]?.["service-doc"][0]?.href, mount);
    assert.ok(manifest.artifacts.api);
    const specResponse = await get(
      manifest.artifacts.api.openapi,
      "application/json"
    );
    const spec: ApiSpecDocument = await specResponse.json();
    assert.ok(spec.paths["/docs/api/docs/pages.json"]);
    const anchor = catalog.linkset[0]?.anchor;
    assert.equal(anchor, `${mount}/api/docs/pages.json`);
    assert.ok(anchor);
    const namespaceResponse = await get(anchor, "application/json");
    assert.deepEqual(await namespaceResponse.json(), index);
    const response = await fetch(`${origin}${base}/plugin-proof`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(await response.text(), "plugin ran");
  } finally {
    await server.stop();
  }
};

const buildAndProbe = async (root: string, base: string): Promise<void> => {
  const options = {
    configFile: "astro.config.mjs",
    logLevel: "error" as const,
    outDir: join(root, "production-output"),
    root,
    server: { host: "127.0.0.1", port: 0 },
  };
  await build(options);
  const server = await preview(options);
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const getJson = async (path: string): Promise<Response> => {
      const response = await fetch(`${origin}${path}`, {
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.status, 200, path);
      assert.ok(
        response.headers.get("content-type")?.startsWith("application/json"),
        path
      );
      return response;
    };
    const rootResponse = await getJson(`${base}/api/docs/pages.json`);
    const rootIndex: ApiPagesIndex = await rootResponse.json();
    const mountedResponse = await getJson(`${base}/docs/api/docs/pages.json`);
    assert.deepEqual(await mountedResponse.json(), rootIndex);
    const [entry] = rootIndex.pages;
    assert.ok(entry);
    assert.equal(entry.json, `${base}/docs/api/docs/pages/docs.json`);
    const pageResponse = await getJson(entry.json);
    const page: ApiPage = await pageResponse.json();
    assert.match(page.markdown, /Hello docs/u);
    await getJson(`${base}/docs/openapi.json`);
  } finally {
    await server.stop();
  }
};

// A subprocess isolates Astro/Vite from unit tests that replace global Error or module loaders.
// Production uses the same source-realpath fixture layout as configured-integrations.test.ts.
const root = await mkdtemp(
  join(
    process.argv.includes("--build") ? packageRoot() : tmpdir(),
    "blume-mount-"
  )
);
try {
  await mkdir(join(root, "docs"));
  await writeFile(
    join(root, "docs/index.md"),
    "---\ntitle: Welcome\n---\nHello docs."
  );
  await writeFile(
    join(root, "blume.config.ts"),
    `export default { basePath: "/docs", deployment: { base: "/docs" }, vite: { plugins: [{ name: "proof", configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url?.endsWith("/plugin-proof")) { res.end("plugin ran"); } else { next(); } }); } }] } }`
  );
  await mkdir(join(root, "node_modules"));
  const dependencies = await readdir(join(packageRoot(), "node_modules"));
  await Promise.all(
    dependencies
      .filter((name) => !name.startsWith(".") && name !== "blume")
      .map((name) =>
        symlink(
          join(packageRoot(), "node_modules", name),
          join(root, "node_modules", name),
          "junction"
        )
      )
  );
  await symlink(packageRoot(), join(root, "node_modules/blume"), "junction");
  const project = await scanProject(root);
  await generateRuntime(project);
  const verify = process.argv.includes("--build") ? buildAndProbe : probe;
  await verify(project.context.outDir, "/docs");
  await eject(root);
  await verify(root, "/docs");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(root, { force: true, recursive: true });
}
// Astro's dependency optimizer can retain handles after both servers stop.
process.exit();
