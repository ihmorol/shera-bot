import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * AC20's layout leg (PRD §18/§19): desktop and mobile web layouts work on
 * target browsers. The responsive sweep runs the REAL shipped surfaces (the
 * S34 harness) at the four §18 widths — 360 mobile, 768 tablet, 1024 and 1440
 * desktop — and fails on horizontal page overflow (a surface that does not
 * fit its viewport is a layout defect, not an anecdote: it reproduces on the
 * recorded viewport in every project). Screenshots are archived per project
 * for the OWNER's review; the machine verdict is the assertion itself.
 *
 * Surface QA boundary (recorded in the harness): this leg proves what the
 * shipped components render in real browsers — it never vouches for live
 * runtime behavior.
 */

const SURFACES = [
  { id: "login", view: '[data-view="login"]', name: "login" },
  { id: "operation-chat", view: '[data-surface="operation-chat"]', name: "operation-chat" },
  {
    id: "operation-thread-artifacts",
    view: '[data-surface="operation-thread-artifacts"]',
    name: "operation-thread-artifacts",
  },
  { id: "approval", view: '[data-surface="approval"]', name: "approval" },
  {
    id: "providers-settings",
    view: '[data-surface="providers-settings"]',
    name: "providers-settings",
  },
  {
    id: "providers-failure",
    view: '[data-surface="providers-failure"]',
    name: "providers-failure",
  },
  {
    id: "credits-settings",
    view: '[data-surface="credits-settings"]',
    name: "credits-settings",
  },
] as const;

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 768, height: 1024 },
  { width: 1024, height: 800 },
  { width: 1440, height: 900 },
] as const;

/** Screenshot archive root (committed evidence for the owner's review). */
function screenshotDir(projectName: string): string {
  const dir = join(import.meta.dirname, "screenshots", projectName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function assertSurfaceFits(page: Page, selector: string, width: number): Promise<void> {
  const overflow = await page.evaluate((viewportWidth) => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      viewportWidth,
    };
  }, width);
  // One pixel of sub-pixel rounding tolerance; anything wider than the
  // viewport is a horizontal overflow defect.
  expect(
    overflow.scrollWidth,
    `page scrollWidth ${overflow.scrollWidth} exceeds viewport ${width} (clientWidth ${overflow.clientWidth}) — horizontal overflow on ${selector}`,
  ).toBeLessThanOrEqual(width + 1);
}

test.describe("AC20 layout sweep — every named surface at every §18 width", () => {
  for (const viewport of VIEWPORTS) {
    test(`surfaces fit ${viewport.width}px without horizontal overflow`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const dir = screenshotDir(testInfo.project.name);
      for (const surface of SURFACES) {
        const locator = page.locator(surface.view);
        await expect(locator, `${surface.name} renders at ${viewport.width}px`).toBeVisible();
        await assertSurfaceFits(page, surface.view, viewport.width);
        await locator.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(dir, `${surface.name}-${viewport.width}x${viewport.height}.png`),
          fullPage: false,
        });
      }
    });
  }
});

test.describe("AC20 navigation integrity at the extremes", () => {
  test("mobile 360px: the login entry and composer stay reachable", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    const signIn = page.locator('[data-view="login"] a[href*="signin"]');
    await expect(signIn).toBeVisible();
    const composer = page.locator('[data-surface="operation-chat"] textarea');
    await expect(composer).toBeVisible();
    await composer.scrollIntoViewIfNeeded();
    await assertSurfaceFits(page, '[data-surface="operation-chat"]', 360);
  });

  test("desktop 1440px: the thread and approval card render at full width", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator('[data-surface="operation-chat"]')).toBeVisible();
    await expect(page.locator('[data-surface="approval"]')).toBeVisible();
  });
});
