"use client";

import { memo } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  ul: ({ children }) => <ul className="list-disc pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ul>,
  ol: ({ children }) => (
    <ol className="list-decimal pl-4 mb-2 last:mb-0 space-y-0.5">{children}</ol>
  ),
  li: ({ children }) => <li className="text-sm">{children}</li>,
  code: ({ className, children, ...props }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className={`block text-xs ${className ?? ""}`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="px-1 py-0.5 rounded bg-bg-hover text-primary text-[13px] font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-bg rounded-md border border-border px-3 py-2 mb-2 last:mb-0 overflow-x-auto font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  a: ({ href, children }) =>
    href?.startsWith("/") && !href.startsWith("//") ? (
      <Link href={href} className="text-primary hover:underline">
        {children}
      </Link>
    ) : (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {children}
      </a>
    ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-primary/30 pl-3 text-text-muted italic mb-2 last:mb-0">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => <p className="font-bold text-base mb-1">{children}</p>,
  h2: ({ children }) => <p className="font-bold text-sm mb-1">{children}</p>,
  h3: ({ children }) => <p className="font-semibold text-sm mb-1">{children}</p>,
  hr: () => <hr className="border-border my-2" />,
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2 last:mb-0">
      <table className="text-xs border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-2 py-1 text-left font-semibold bg-bg-subtle">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
};

interface ChatMarkdownProps {
  content: string;
}

export const ChatMarkdown = memo(function ChatMarkdown({ content }: ChatMarkdownProps) {
  return (
    <div className="text-sm leading-relaxed text-text prose-optio">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
