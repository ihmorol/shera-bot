/**
 * A next/navigation stand-in for the harness: the App-Router hooks the
 * shipped components import, as inert no-ops. The harness mounts components
 * whose navigation is prop-driven (onNavigate) or irrelevant to the surface
 * assertions; no client-side routing exists in a static fixture page.
 */
export function useRouter() {
  return {
    push: () => undefined,
    replace: () => undefined,
    back: () => undefined,
    prefetch: () => undefined,
    refresh: () => undefined,
  };
}

export function usePathname() {
  return "/app";
}

export function useParams() {
  return {};
}

export function useSearchParams() {
  return new URLSearchParams();
}

export function useSelectedLayoutSegments() {
  return [];
}
