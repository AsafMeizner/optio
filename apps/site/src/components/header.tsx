"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";

const links = [
  { href: "/#product", label: "Product" },
  { href: "/platform", label: "How it works" },
  { href: "/#mobile", label: "Mobile" },
  { href: "/docs", label: "Documentation" },
];

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  return (
    <header
      className="site-header"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <nav className="landing-container header-inner" aria-label="Main navigation">
        <Link href="/" className="brand" aria-label="Optio home" onClick={() => setOpen(false)}>
          <Image src="/optio-mark.svg" alt="" width={32} height={32} />
          optio<span className="brand-label">OPEN SOURCE</span>
        </Link>
        <div className="desktop-navigation">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname.startsWith(link.href) ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </div>
        <Link href="/docs/getting-started" className="landing-button primary header-cta">
          Get started <span aria-hidden="true">↗</span>
        </Link>
        <button
          ref={toggle}
          type="button"
          className="menu-toggle"
          onClick={() => setOpen(!open)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="mobile-navigation"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d={open ? "M6 6l12 12M6 18L18 6" : "M4 7h16M4 12h16M4 17h16"} />
          </svg>
        </button>
      </nav>
      {open && (
        <nav id="mobile-navigation" className="mobile-navigation" aria-label="Mobile navigation">
          {links.map((link) => (
            <Link key={link.href} href={link.href} onClick={() => setOpen(false)}>
              {link.label}
              <span aria-hidden="true">↗</span>
            </Link>
          ))}
          <Link href="/docs/getting-started" onClick={() => setOpen(false)}>
            Get started <span aria-hidden="true">↗</span>
          </Link>
        </nav>
      )}
    </header>
  );
}
