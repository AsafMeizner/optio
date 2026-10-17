"use client";

import { useEffect, useRef, useState } from "react";

export function CodeBlock({ children, title }: { children: string; title?: string }) {
  const [status, setStatus] = useState("Copy");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function handleCopy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(children);
      setStatus("Copied");
    } catch {
      setStatus("Select text to copy");
    }
    timer.current = setTimeout(() => setStatus("Copy"), 2500);
  }
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{title ?? "Code"}</span>
        <button type="button" onClick={handleCopy} aria-live="polite">
          {status}
        </button>
      </div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}
