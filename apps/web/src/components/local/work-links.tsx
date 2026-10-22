"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, ExternalLink, Hash } from "lucide-react";
import { BrandIcon, BRAND_LABEL, IssueIcon, PrIcon, brandFor } from "@/components/brand-icon";
import { collectWorkLinks, type WorkLink } from "@optio/shared";

/**
 * Badges for the PR / ticket links a terminal is working on. Every badge
 * opens in a new tab and swallows the click so it works inside clickable
 * cards. The ticket the terminal was spawned from comes first, and each PR
 * / ticket shows once however often it was seen (`collectWorkLinks` in
 * `@optio/shared`; the API folds the ticket in too, so every client agrees).
 */
export { collectWorkLinks };

/** Text a search box should match against for a terminal's links. */
export function workLinksSearchText(links: WorkLink[]): string {
  return links.map((l) => `${l.label} ${l.url}`).join(" ");
}

/**
 * Quiet chips: neutral surface, the kind carried by the icon (GitHub's PR
 * and issue glyphs in their colors, a Linear / Jira ticket by its brand
 * mark, a plain ref grey), so a row of badges reads as a list, not a row
 * of buttons.
 */
function linkTitle(link: WorkLink): string {
  if (link.kind === "pr") return link.provider === "gitlab" ? "Merge request" : "Pull request";
  if (link.kind === "ref") return "Reference";
  const brand = brandFor(link.provider);
  return brand && link.provider !== "github" ? `${BRAND_LABEL[brand]} ticket` : "Issue";
}

export function WorkLinkIcon({ link, className }: { link: WorkLink; className?: string }) {
  if (link.kind === "pr") return <PrIcon state="open" className={className} />;
  if (link.kind === "issue") {
    if (link.provider === "linear" || link.provider === "jira") {
      return <BrandIcon brand={link.provider} className={cn("text-text", className)} />;
    }
    return <IssueIcon state="open" className={className} />;
  }
  return <Hash className={cn("shrink-0 text-text-muted", className)} aria-hidden />;
}

export function WorkLinkBadge({ link, size = "sm" }: { link: WorkLink; size?: "xs" | "sm" }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${linkTitle(link)} · ${link.url}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border/70 bg-bg-card/60 font-mono max-w-full",
        "text-text-muted hover:text-text hover:border-border-strong transition-colors",
        size === "xs" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
      )}
    >
      <WorkLinkIcon link={link} className={size === "xs" ? "w-3 h-3" : "w-3.5 h-3.5"} />
      <span className="truncate">{link.label}</span>
      {size === "sm" && <ExternalLink className="w-3 h-3 opacity-40 shrink-0" />}
    </a>
  );
}

export function WorkLinkBadges({
  links,
  size = "sm",
  max,
  className,
}: {
  links: WorkLink[];
  size?: "xs" | "sm";
  /** Initially show this many, with a toggle to expand and collapse the rest. */
  max?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (links.length === 0) return null;
  const limit = max && max > 0 ? max : links.length;
  const shown = expanded ? links : links.slice(0, limit);
  const rest = links.length - limit;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <div className={cn("flex items-center gap-1 flex-wrap min-w-0", className)}>
      {shown.map((l) => (
        <WorkLinkBadge key={l.url} link={l} size={size} />
      ))}
      {rest > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Show fewer links" : `Show ${rest} more links`}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((value) => !value);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1 shrink-0 rounded-md border border-transparent text-text-muted hover:text-text hover:bg-bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            size === "xs" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
          )}
        >
          {expanded ? "Show less" : `+${rest} more`}
          <Chevron className="h-3 w-3" aria-hidden />
        </button>
      )}
    </div>
  );
}
