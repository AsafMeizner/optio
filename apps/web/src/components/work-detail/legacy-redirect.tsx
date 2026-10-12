"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function LegacyWorkRedirect({ id }: { id: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/work/${id}${window.location.search}${window.location.hash}`);
  }, [id, router]);
  return <div className="p-6 text-sm text-text-muted">Opening work…</div>;
}
