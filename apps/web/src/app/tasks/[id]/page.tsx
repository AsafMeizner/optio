"use client";

import { use } from "react";
import { LegacyWorkRedirect } from "@/components/work-detail/legacy-redirect";

export default function LegacyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <LegacyWorkRedirect id={id} />;
}
