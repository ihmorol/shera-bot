import type { ComponentProps, ReactNode } from "react";

/** A next/link stand-in for the harness: the same anchor render shape. */
export default function Link({
  children,
  href,
  ...rest
}: ComponentProps<"a"> & { href: string; children: ReactNode }) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
