import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Shared conversation-surface frame for the chunk-1 skeleton: a header
 * (title + optional mono meta) and a body. Pages render their own honest
 * empty-state copy inside the body — §2.4: one-line explanation plus the
 * single most likely next action.
 */
export function SurfaceFrame({
  title,
  meta,
  actions,
  children,
  className,
}: {
  title: string;
  meta?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col", className)}>
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 lg:px-6">
        <div className="min-w-0">
          <h1 className="truncate font-display text-lg font-semibold tracking-tight text-text">
            {title}
          </h1>
          {meta ? (
            <p className="truncate font-mono text-xs tracking-[0.08em] text-muted">{meta}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 lg:px-6">{children}</div>
    </div>
  );
}

/** §2.4 empty state: centered, one-line explanation, one obvious action. */
export function EmptyState({ explanation, action }: { explanation: string; action?: ReactNode }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center text-center">
      <p className="text-sm text-muted">{explanation}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
