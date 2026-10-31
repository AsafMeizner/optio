"use client";

import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useOnboarding } from "@/hooks/use-onboarding";
import { PageHeader } from "@/components/page-header";
import { GuideMarkdown } from "@/components/help/guide-markdown";
import { USING_OPTIO_GUIDE } from "@/content/using-optio-guide";

/**
 * The guide for the people who use Optio (docs/using-optio.md), in the app:
 * Help → Using Optio. Only while a deployment admin has the getting-started
 * guide on (Settings → Access); otherwise the page doesn't exist, as without
 * the guide.
 */
export default function HelpPage() {
  usePageTitle("Using Optio");
  const { onboarding, loaded } = useOnboarding();
  if (!loaded) return null;
  if (!onboarding) notFound();
  return (
    <div className="page-column py-6">
      <PageHeader
        icon={BookOpen}
        title="Using Optio"
        description="Starting work, following it, reviewing and merging: the guide for the people who use Optio."
      />
      {/* The page header is the guide's title. */}
      <GuideMarkdown source={USING_OPTIO_GUIDE.replace(/^# .*\n+/, "")} />
    </div>
  );
}
