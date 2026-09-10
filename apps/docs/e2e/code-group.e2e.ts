import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

const componentsUrl = "/docs/content/components";
const fence = (title: string, source = title, option = "") =>
  `<pre data-title="${title}" data-code-option="${option}"><code>${source}</code></pre>`;
const group = (id: string, content: string, attributes = "") =>
  `<blume-tabs id="${id}" data-hash="false" ${attributes}><div><div data-blume-tablist role="tablist"></div><div data-blume-tab-actions></div></div><div data-blume-tab-content>${content}</div></blume-tabs>`;

const mount = async (page: Page, html: string) => {
  const retainedFences = await page.evaluate(async (markup) => {
    await customElements.whenDefined("blume-tabs");
    const host = document.createElement("div");
    host.className = "prose";
    host.innerHTML = markup;
    const fences = [...host.querySelectorAll("pre")];
    document.body.append(host);
    document.dispatchEvent(new Event("astro:after-swap"));
    return fences.every((pre) => host.contains(pre));
  }, html);
  expect(retainedFences).toBe(true);
};

const captureClipboard = async (page: Page) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(text: string) {
          document.body.dataset.copiedCode = text;
          return Promise.resolve();
        },
      },
    });
  });
};

test.beforeEach(async ({ page }) => {
  await page.goto(componentsUrl);
});

test("authored mappings preserve direct fences, metadata, order, and per-block copying", async ({
  page,
}) => {
  const tabs = page.locator("blume-tabs[data-tab-values]").first();
  await expect(tabs).toHaveAttribute("data-blume-tabs-ready", "true");
  const panels = tabs.locator(
    ":scope > [data-blume-tab-content] > [data-blume-tab-panel]"
  );
  await expect(panels).toHaveCount(2);
  await expect(panels.nth(0)).toHaveAttribute("data-tab-id", "node");
  await expect(panels.nth(1)).toHaveAttribute("data-tab-id", "python");
  await expect(panels.nth(0).locator(":scope > pre")).toHaveCount(2);
  const configure = panels.nth(0).locator(":scope > pre").nth(1);
  await expect(configure).toHaveAttribute("data-title", "Configure");
  await expect(configure).toHaveAttribute("data-code-option", "runtime=node");
  await expect(
    tabs.locator("[data-blume-tab-actions] [data-blume-copy]")
  ).toHaveCount(0);
  await captureClipboard(page);
  await panels
    .nth(0)
    .locator(":scope > pre")
    .first()
    .evaluate((pre: HTMLPreElement) => {
      pre.hidden = true;
    });
  await configure.locator("[data-blume-copy]").click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-copied-code",
    'export const runtime = "node";'
  );
  await tabs.getByRole("tab", { exact: true, name: "Python" }).click();
  await panels.nth(1).locator("[data-blume-copy]").click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-copied-code",
    'print("Hello")'
  );
});

test("interleaved aliases group by first occurrence without cloning fences", async ({
  page,
}) => {
  await mount(
    page,
    group(
      "aliases",
      fence("A", "first") + fence("B", "second") + fence("Alias", "third"),
      `data-tab-values='{"A":"a","Alias":"a","B":"b"}'`
    )
  );
  const tabs = page.locator("#aliases");
  await expect(tabs.getByRole("tab")).toHaveText(["A", "B"]);
  const panels = tabs.locator("[data-blume-tab-panel]");
  await expect(panels.first().locator(":scope > pre > code")).toHaveText([
    "first",
    "third",
  ]);
  await expect(panels.last().locator(":scope > pre > code")).toHaveText([
    "second",
  ]);
  await expect(tabs.locator("pre")).toHaveCount(3);
});

test("invalid mappings fail atomically without inherited-property lookups or crashes", async ({
  page,
}) => {
  const invalid = [
    "",
    "{",
    "null",
    "[]",
    "true",
    "42",
    '"string"',
    "{}",
    '{"A":null,"constructor":"ctor"}',
    '{"A":4,"constructor":"ctor"}',
    '{"A":[],"constructor":"ctor"}',
    '{"A":{},"constructor":"ctor"}',
    '{"A":"","constructor":"ctor"}',
    '{"A":"   ","constructor":"ctor"}',
    '{"A":"a","constructor":"ctor","":"empty key"}',
    '{"A":"a","constructor":"ctor","Unused":false}',
    '{"A":"a"}',
  ];
  await mount(
    page,
    invalid
      .map((value, index) =>
        group(
          `invalid-${index}`,
          fence("A") + fence("constructor"),
          `data-tab-values='${value}'`
        )
      )
      .join("")
  );
  await Promise.all(
    invalid.map(async (_, index) => {
      const tabs = page.locator(`#invalid-${index}`);
      await expect(tabs).toHaveAttribute("data-code-group-invalid", "true");
      await expect(tabs.getByRole("tab")).toHaveCount(2);
      await expect(
        tabs.locator(":scope > [data-blume-tab-content] > pre")
      ).toHaveCount(2);
      await tabs
        .getByRole("tab", { exact: true, name: "constructor" })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect(tabs.locator("pre").last()).toBeVisible();
    })
  );
  await mount(
    page,
    group(
      "own-keys",
      fence("__proto__") + fence("constructor"),
      `data-tab-values='{"__proto__":"proto","constructor":"ctor"}'`
    )
  );
  await expect(page.locator("#own-keys")).not.toHaveAttribute(
    "data-code-group-invalid"
  );
  await expect(
    page.locator("#own-keys [data-blume-tab-panel]").first()
  ).toHaveAttribute("data-tab-id", "proto");
});

test("explicit and nested panels retain ownership, keyed sync, keyboard, and reconnection", async ({
  page,
}) => {
  const pair = fence("One") + fence("Two");
  const nested = group("inner", pair, 'data-sync-key="inner"');
  const outerPanels = `<div data-blume-tab-panel data-title="One">${nested}</div><div data-blume-tab-panel data-title="Two">Outer two</div>`;
  await mount(
    page,
    group(
      "outer",
      outerPanels,
      `data-sync-key="outer" data-tab-values='null'`
    ) +
      group("peer", pair, 'data-sync-key="outer"') +
      group("isolated", pair, 'data-sync-key="isolated"')
  );
  const outer = page.locator("#outer");
  const triggers = outer.locator(
    ":scope > div > [data-blume-tablist] > button"
  );
  await expect(triggers).toHaveCount(2);
  await expect(outer).not.toHaveAttribute("data-code-group-invalid");
  await page
    .locator("#inner")
    .getByRole("tab", { exact: true, name: "Two" })
    .click();
  await expect(triggers.first()).toHaveAttribute("aria-selected", "true");
  await triggers.first().focus();
  await page.keyboard.press("End");
  await expect(triggers.last()).toBeFocused();
  await expect(triggers.last()).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator("#peer").getByRole("tab", { exact: true, name: "Two" })
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.locator("#isolated").getByRole("tab", { exact: true, name: "One" })
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(triggers.first()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(triggers.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(triggers.first()).toBeFocused();
  const id = await triggers.first().getAttribute("id");
  await outer.evaluate((element) => {
    const parent = element.parentElement;
    element.remove();
    parent?.append(element);
  });
  await expect(triggers).toHaveCount(2);
  await expect(triggers.first()).toHaveAttribute("id", id ?? "");
  await page
    .locator("#peer")
    .getByRole("tab", { exact: true, name: "Two" })
    .click();
  await expect(triggers.last()).toHaveAttribute("aria-selected", "true");
});

test("mapped dropdowns use canonical query values and reconnect URL listeners", async ({
  page,
}) => {
  await page.evaluate(() => history.replaceState(null, "", "?example=b"));
  await mount(
    page,
    group(
      "dropdown",
      fence("A") + fence("Alias") + fence("B"),
      `data-dropdown="true" data-param="example" data-tab-values='{"A":"a","Alias":"a","B":"b"}'`
    )
  );
  const tabs = page.locator("#dropdown");
  await expect(tabs.locator("select")).toHaveValue("1");
  await expect(tabs.locator('[data-tab-id="b"]')).toBeVisible();
  await tabs.locator("select").selectOption("0");
  await expect(page).toHaveURL(/\?example=a$/u);
  await tabs.evaluate((element) => {
    const parent = element.parentElement;
    element.remove();
    parent?.append(element);
  });
  await page.evaluate(() => {
    history.replaceState(null, "", "?example=b");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(tabs.locator("select")).toHaveValue("1");
  await expect(tabs.locator("select option")).toHaveCount(2);
});

test("shared copying follows visible single-fence panels and never falls back to hidden code", async ({
  page,
}) => {
  await mount(
    page,
    group(
      "single",
      fence("A", "first") + fence("B", "second"),
      `data-tab-values='{"A":"a","B":"b"}'`
    )
  );
  await captureClipboard(page);
  const tabs = page.locator("#single");
  const copy = tabs.locator("[data-blume-tab-actions] [data-blume-copy]");
  await expect(copy).toHaveCount(1);
  await expect(tabs.locator("pre [data-blume-copy]")).toHaveCount(0);
  await tabs.locator('[data-tab-id="b"] code').evaluate((code) => {
    const popup = document.createElement("span");
    popup.className = "twoslash-popup-container";
    popup.textContent = "hover documentation must not be copied";
    code.append(popup);
  });
  await tabs.getByRole("tab", { exact: true, name: "B" }).click();
  await copy.click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-copied-code",
    "second"
  );
  await tabs.locator('[data-tab-id="b"] pre').evaluate((pre) => {
    pre.style.display = "none";
  });
  await page.locator("body").evaluate((body) => {
    delete body.dataset.copiedCode;
  });
  await copy.click();
  await expect(page.locator("body")).not.toHaveAttribute("data-copied-code");
  await tabs.locator('[data-tab-id="b"]').evaluate((panel: HTMLElement) => {
    panel.hidden = true;
  });
  await copy.click();
  await expect(page.locator("body")).not.toHaveAttribute("data-copied-code");
});

test("multi-fence explicit panels and figures retain independent copy buttons", async ({
  page,
}) => {
  await mount(
    page,
    group(
      "explicit-copy",
      `<div data-blume-tab-panel data-title="Examples"><template data-blume-tab-icon></template>${fence("A", "first")}<figure>${fence("B", "second")}</figure></div>`
    )
  );
  const tabs = page.locator("#explicit-copy");
  await expect(
    tabs.locator("[data-blume-tab-actions] [data-blume-copy]")
  ).toHaveCount(0);
  await expect(tabs.locator("pre [data-blume-copy]")).toHaveCount(2);
  await captureClipboard(page);
  await tabs
    .locator("pre")
    .first()
    .evaluate((pre) => {
      pre.classList.add("hidden");
    });
  await tabs.locator("figure [data-blume-copy]").click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-copied-code",
    "second"
  );
});

test("borderless frames remove chrome while preserving media, captions, hints, and autoplay", async ({
  page,
}) => {
  const borderless = page.locator("blume-frame").filter({
    has: page.getByRole("img", { exact: true, name: "Borderless sample" }),
  });
  const bordered = page.locator("blume-frame").filter({
    has: page.getByRole("img", { exact: true, name: "Sample frame" }),
  });
  const surface = borderless.locator(":scope > figure > div");
  await expect(surface).toHaveCSS("border-top-width", "0px");
  await expect(surface).toHaveCSS("padding-top", "0px");
  await expect(surface).toHaveCSS("border-radius", "0px");
  await expect(surface).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(surface).toHaveCSS("justify-content", "center");
  await expect(borderless.locator("figcaption strong")).toHaveText(
    "borderless"
  );
  await expect(borderless.locator("figure > p")).toHaveText(
    "No surrounding frame chrome."
  );
  await expect(bordered.locator(":scope > figure > div")).toHaveCSS(
    "border-top-width",
    "1px"
  );
  await borderless.evaluate((element) => {
    const video = document.createElement("video");
    video.autoplay = true;
    element.querySelector("figure > div")?.append(video);
    const parent = element.parentElement;
    element.remove();
    parent?.append(element);
  });
  const video = borderless.locator("video");
  await expect(video).toHaveJSProperty("muted", true);
  await expect(video).toHaveJSProperty("loop", true);
  await expect(video).toHaveJSProperty("playsInline", true);
  await expect(video).toHaveCSS("max-width", "100%");
});
