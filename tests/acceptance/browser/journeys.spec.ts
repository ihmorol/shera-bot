import { expect, test } from "@playwright/test";

/**
 * The §18 core journeys at component-surface level (the S34 harness boundary:
 * the REAL shipped surfaces over frozen fixtures — the live-runtime journey
 * legs are the vitest rows, e.g. AC7's mock-runtime E2E; this spec proves the
 * browser-side behavior of the journey's UI steps in every §18 browser
 * project).
 *
 * Journeys: login entry → Operation chat send → artifact/result visibility →
 * approval decision → recovery after refresh (deterministic re-render) →
 * settings → provider configuration failure path (G4: a configuration state,
 * never fake success).
 */

test.describe("core journeys in real browsers", () => {
  test("login → the Google sign-in entry points at the control plane", async ({ page }) => {
    await page.goto("/");
    const signIn = page.locator('[data-view="login"] a[href*="signin"]');
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute("href", "/api/control/api/auth/signin/google");
    // The five-account cap copy is on the entry surface (AC1's UI leg).
    await expect(page.getByText(/capped at five accounts/)).toBeVisible();
  });

  test("Operation chat → send → artifact and run cards visible", async ({ page }) => {
    await page.goto("/");
    // Send through the real composer.
    const composer = page.locator('[data-surface="operation-chat"] textarea');
    await composer.scrollIntoViewIfNeeded();
    await composer.fill("Research the acceptance ledger format");
    await composer.press("Enter");
    await expect(page.getByText("Research the acceptance ledger format")).toBeVisible();

    // The result leg: the artifacts surface carries real artifact/run cards
    // from the frozen thread fixtures.
    const artifacts = page.locator('[data-surface="operation-thread-artifacts"]');
    await artifacts.scrollIntoViewIfNeeded();
    await expect(artifacts.getByText(/artifact|download|Download/i).first()).toBeVisible();
  });

  test("approval → the five choices decide; the chosen decision is recorded", async ({ page }) => {
    await page.goto("/");
    const review = page.locator('[data-surface="approval"] button', { hasText: "Review" }).first();
    await review.scrollIntoViewIfNeeded();
    await review.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const labels = await page.evaluate(
      () =>
        (window as { SHERA_APPROVAL_CHOICE_LABELS?: readonly string[] })
          .SHERA_APPROVAL_CHOICE_LABELS,
    );
    expect((labels ?? []).length).toBe(5);
    const firstChoice = labels![0]!;
    await dialog.getByRole("button", { name: firstChoice }).click();
    // The decision content renders the chosen choice (the real modal's state).
    await expect(page.getByText(firstChoice).first()).toBeVisible();
  });

  test("recovery after refresh → the thread re-renders deterministically", async ({ page }) => {
    await page.goto("/");
    const thread = page.locator(
      '[data-surface="operation-chat"] ol[aria-label="Conversation messages"] li',
    );
    const before = await thread.count();
    expect(before).toBeGreaterThan(0);
    await page.reload();
    const after = await thread.locator("visible=true").count();
    // The frozen fixture thread is deterministic: a refresh replays the same
    // timeline (the surface-level replay leg; the runtime replay leg is AC7's
    // mock-runtime E2E suite).
    expect(after).toBe(before);
  });

  test("settings → credits read-out renders the real ledger fields", async ({ page }) => {
    await page.goto("/");
    const credits = page.locator('[data-surface="credits-settings"]');
    await credits.scrollIntoViewIfNeeded();
    await expect(credits.getByText(/remaining|granted|reserved/i).first()).toBeVisible();
  });

  test("provider configuration failure shows a configuration state, never fake success (G4)", async ({
    page,
  }) => {
    await page.goto("/");
    const failure = page.locator('[data-surface="providers-failure"]');
    await failure.scrollIntoViewIfNeeded();
    // The safe, redacted failure copy is the surface's message.
    await expect(failure.getByText(/could not be loaded/i)).toBeVisible();
    // A retry affordance exists.
    await expect(failure.getByRole("button", { name: /retry/i })).toBeVisible();
    // The G4 negative: no provider row or connected/success status may render
    // in the failure state.
    await expect(failure.getByText(/connected/i)).toHaveCount(0);
    await expect(failure.locator("[data-provider-id], [data-provider]")).toHaveCount(0);
  });
});
