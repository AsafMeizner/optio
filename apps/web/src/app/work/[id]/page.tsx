"use client";

import { Suspense, use } from "react";
import { WorkDetail } from "@/components/work-detail/work-detail";

export default function WorkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div className="p-6 text-sm text-text-muted">Loading work…</div>}>
      <WorkDetail key={id} id={id} />
    </Suspense>
  );
}
