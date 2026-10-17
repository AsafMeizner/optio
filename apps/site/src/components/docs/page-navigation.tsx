"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docsNav } from "@/content/docs";

const pages = docsNav.flatMap((section) => section.pages);
export function DocsPageNavigation({ position }: { position: "top" | "bottom" }) {
  const pathname = usePathname().replace(/\/$/, "");
  const index = pages.findIndex((page) => page.href === pathname);
  const current = pages[index];
  const section = docsNav.find((section) => section.pages.some((page) => page.href === pathname));
  if (position === "top")
    return (
      <nav className="docs-breadcrumb" aria-label="Breadcrumb">
        <Link href="/docs">Documentation</Link>
        {current && (
          <>
            <span aria-hidden="true">/</span>
            <span>{section?.title}</span>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{current.title}</span>
          </>
        )}
      </nav>
    );
  if (!current) return null;
  const previous = pages[index - 1];
  const next = pages[index + 1];
  return (
    <nav className="docs-pagination" aria-label="Previous and next guides">
      <Link href={previous?.href ?? "/docs"}>
        <span>← Previous</span>
        {previous?.title ?? "Documentation"}
      </Link>
      {next && (
        <Link href={next.href}>
          <span>Next →</span>
          {next.title}
        </Link>
      )}
    </nav>
  );
}
