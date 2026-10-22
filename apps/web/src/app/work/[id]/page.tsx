"use client";

import { Suspense, use } from "react";
import { WorkDetail } from "@/components/work-detail/work-detail";
import { SessionSkeleton } from "@/components/skeleton";

export default function WorkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<SessionSkeleton />}>
      <WorkDetail key={id} id={id} />
    </Suspense>
  );
}
