import { createElement, type ReactElement, type ReactNode } from "react";
import { render, renderToStaticMarkup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * S21 test helper: render (or stringify) a React tree under a fresh
 * QueryClientProvider. The chat surfaces' tool cards read the runtime tool
 * history through TanStack Query (the S21 hydration), so any tree that
 * renders a message list needs the provider — the same requirement the
 * S18 live-view tabs introduced for the panel body.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
    },
  });
}

export function renderWithQueryClient(node: ReactNode): ReturnType<typeof render> {
  const client = createTestQueryClient();
  return render(createElement(QueryClientProvider, { client }, node));
}

export function staticMarkupWithQueryClient(node: ReactNode): string {
  const client = createTestQueryClient();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node));
}

export type { ReactElement };
