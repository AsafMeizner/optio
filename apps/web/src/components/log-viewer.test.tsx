import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { LogLine } from "./log-viewer";
import { ThinkingFold } from "./thinking-fold";
import type { LogEntry } from "@/hooks/use-logs";

afterEach(cleanup);

const tableMarkdown = ["| Col A | Col B |", "| ----- | ----- |", "| a1    | b1    |"].join("\n");

describe("LogLine (text branch)", () => {
  it("renders text-type content as markdown when no search query is active", () => {
    const { container } = render(
      <LogLine log={{ logType: "text", content: tableMarkdown }} searchQuery="" />,
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("falls back to plain-text rendering with highlight when searchQuery is set", () => {
    const { container } = render(
      <LogLine log={{ logType: "text", content: tableMarkdown }} searchQuery="Col A" />,
    );
    // Markdown table is suppressed so the substring highlighter can wrap matches
    expect(container.querySelector("table")).toBeNull();
    const marks = container.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent).toBe("Col A");
  });

  it("renders default text (no logType) as markdown", () => {
    const { container } = render(
      <LogLine log={{ content: "## A heading\n\nSome **bold** text." }} searchQuery="" />,
    );
    expect(container.querySelector("h2")).not.toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
  });

  it("does not invoke markdown rendering for tool_result entries", () => {
    const { container } = render(
      <LogLine
        log={{ logType: "tool_result", content: "| Col A | Col B |\n| --- | --- |\n| a | b |" }}
        searchQuery=""
      />,
    );
    // tool_result is rendered inside <pre>, never as a real <table>
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
  });
});

describe("ThinkingFold", () => {
  const entries: LogEntry[] = [
    {
      content: "first thought",
      stream: "stdout",
      timestamp: "2026-10-22T10:00:00.000Z",
      logType: "thinking",
      metadata: { thinkingTokens: 30 },
    },
    {
      content: "second thought",
      stream: "stdout",
      timestamp: "2026-10-22T10:00:01.000Z",
      logType: "thinking",
      metadata: { thinkingTokens: 12 },
    },
  ];

  it("folds the blocks into one collapsed row that opens on click", () => {
    render(
      <ThinkingFold entries={entries} renderEntry={(e) => <LogLine log={e} searchQuery="" />} />,
    );
    const toggle = screen.getByRole("button", { name: "Thinking (2 blocks · 42 tokens)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("first thought")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("first thought")).toBeInTheDocument();
    expect(screen.getByText("second thought")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText("second thought")).not.toBeInTheDocument();
  });

  it("opens every fold with the viewer's Thinking toggle", () => {
    const { rerender } = render(
      <ThinkingFold entries={entries} defaultOpen renderEntry={(e) => <span>{e.content}</span>} />,
    );
    expect(screen.getByText("first thought")).toBeInTheDocument();
    rerender(
      <ThinkingFold
        entries={entries}
        defaultOpen={false}
        renderEntry={(e) => <span>{e.content}</span>}
      />,
    );
    expect(screen.queryByText("first thought")).not.toBeInTheDocument();
  });
});
