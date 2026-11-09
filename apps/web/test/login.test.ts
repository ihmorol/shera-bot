import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import LoginPage from "../app/login/page";
import AppLayout from "../app/app/layout";
import { routes } from "../lib/routes";

// The app chrome's next/navigation surface: the active path (the nav
// highlight) and the router the notification center's Settings jump
// soft-navigates through (the taste-pass fix — never a full reload).
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/settings",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

describe("production entry", () => {
  it("offers a working control-plane sign-in link without pretending to authenticate", () => {
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain(`href="${routes.controlPlaneSignIn()}"`);
    expect(html).not.toContain(' disabled=""');
    expect(html).not.toContain("not wired");
  });

  it("gates nested app routes before rendering private or fixture content", () => {
    const html = renderToStaticMarkup(
      createElement(AppLayout, { children: "private route sentinel" }),
    );
    expect(html).toContain("Resolving your workspace");
    expect(html).not.toContain("private route sentinel");
  });
});
