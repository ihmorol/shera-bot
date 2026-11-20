/**
 * The shared empty-state primitive (D52 wave E — the value-promise sweep):
 * the E43 pattern 3 / reverse-engineering annex §6 formula — ONE icon, ONE
 * value-promise sentence, at most one CTA, and a CTA only when the caller
 * surface actually owns that action (G4: nothing invented). 13–14px muted
 * text, centered, never more than two lines. Loading (skeleton) and error
 * (redacted safe_message + retry, D23 rule 4) keep their existing shapes in
 * the same module; this suite pins the EMPTY state only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Bell } from "lucide-react";

import { EmptyState } from "../components/shell/states";

function render(props: Parameters<typeof EmptyState>[0]): string {
  return renderToStaticMarkup(createElement(EmptyState, props));
}

describe("EmptyState — the value-promise formula (annex §6, E43 pattern 3)", () => {
  it("renders one icon and one muted value-promise sentence", () => {
    const html = render({
      icon: Bell,
      message: "Nothing for you yet. Approvals, completions, and failures show up here.",
    });
    // ONE icon — decorative; the sentence carries the meaning.
    expect(html).toContain("lucide-bell");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(
      "Nothing for you yet. Approvals, completions, and failures show up here.",
    );
    // 14px muted/secondary text — the annex §6 register.
    expect(html).toContain("text-sm");
    expect(html).toContain("text-muted");
  });

  it("renders no action affordance when the surface has none to offer", () => {
    const html = render({ icon: Bell, message: "Nothing for you yet." });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  it("renders at most one action — the single most likely next action", () => {
    const html = render({
      message: "No triggers yet. Schedules and watchers for your Operations appear here.",
      action: createElement("button", null, "New trigger"),
    });
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons.length).toBe(1);
    expect(html).toContain("New trigger");
  });

  it("renders the centered block without an icon when the caller passes none", () => {
    const html = render({ message: "Nothing in this scope yet." });
    expect(html).toContain("Nothing in this scope yet.");
    expect(html).not.toContain("lucide");
  });
});
