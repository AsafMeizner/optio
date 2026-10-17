"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { docsNav } from "@/content/docs";

export function DocsSidebar() {
  const pathname = usePathname().replace(/\/$/, "");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sections = docsNav
    .map((section) => ({
      ...section,
      pages: section.pages.filter((page) =>
        `${section.title} ${page.title}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    }))
    .filter((section) => section.pages.length);

  return (
    <aside className="docs-sidebar">
      <button
        type="button"
        className="docs-menu-toggle"
        aria-expanded={mobileOpen}
        aria-controls="docs-navigation"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        Documentation menu <span aria-hidden="true">{mobileOpen ? "−" : "+"}</span>
      </button>
      <div id="docs-navigation" className="docs-navigation" data-open={mobileOpen}>
        <label className="docs-filter">
          Find a guide
          <input
            type="search"
            placeholder="Filter by title…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav aria-label="Documentation">
          {sections.map((section) => (
            <div key={section.title}>
              <h2>{section.title}</h2>
              <ul>
                {section.pages.map((page) => (
                  <li key={page.href}>
                    <Link
                      href={page.href}
                      aria-current={pathname === page.href ? "page" : undefined}
                      onClick={() => setMobileOpen(false)}
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        {sections.length === 0 && (
          <p className="docs-empty" role="status">
            No matching guides. Try “work”, “installation”, or “connections”.
          </p>
        )}
      </div>
    </aside>
  );
}
