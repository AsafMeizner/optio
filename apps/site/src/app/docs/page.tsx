import type { Metadata } from "next";
import Link from "next/link";
import { docsNav } from "@/content/docs";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Optio documentation — learn how to install, configure, and run AI coding agents with autonomous feedback loops on Kubernetes.",
};

const sectionIcons: Record<string, string> = {
  "Getting Started": "\u2192",
  "Core Concepts": "\u25CE",
  Guides: "\u26A1",
  Reference: "\u2699",
};

const sectionDescriptions: Record<string, string> = {
  "Getting Started":
    "Install Optio, run the setup script, and configure your first repository and agent.",
  "Core Concepts":
    "Understand the Work model, execution pools, worktree concurrency, and the task lifecycle.",
  Guides:
    "Step-by-step walkthroughs for creating tasks, connecting repos, configuring review agents, building workflows, setting up connections, and integrating with external tools.",
  Reference: "API endpoints, production deployment guide, and contributor documentation.",
};

export default function DocsIndex() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Documentation</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Learn how to deploy Optio, connect your tools, and put your agents to work. Tasks, recurring
        automations, interactive sessions, and persistent agents share one Work feed. Five choices
        describe each piece of work: When, Where, Who, What, and Then.
      </p>
      <div className="docs-start">
        <Link href="/docs/getting-started">
          <h2>Run your first workflow</h2>
          <p>
            Deploy locally, connect an agent and repository, and follow your first piece of work.
          </p>
          <span>Start the quickstart ↗</span>
        </Link>
        <Link href="/docs/deployment">
          <h2>Plan your deployment</h2>
          <p>
            Configure Helm, managed databases, authentication, and execution for your environment.
          </p>
          <span>Read the deployment guide ↗</span>
        </Link>
      </div>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        {docsNav.map((section) => (
          <div key={section.title} className="rounded-xl border border-border bg-bg-card p-6">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-bg-subtle text-sm font-mono text-text-muted">
                {sectionIcons[section.title] ?? "\u25C7"}
              </span>
              <h2 className="text-lg font-semibold text-text-heading">{section.title}</h2>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
              {sectionDescriptions[section.title]}
            </p>
            <ul className="mt-4 space-y-2">
              {section.pages.map((page) => (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    className="group flex items-center gap-2 text-[14px] text-text-muted hover:text-primary-light transition-colors"
                  >
                    <span className="text-border-strong group-hover:text-primary-light transition-colors">
                      {"\u203A"}
                    </span>
                    {page.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
