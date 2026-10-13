// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useSessionOrder } from "./use-session-order";

it("preserves recency while refreshing row data, honors pins and admits new sessions", () => {
  const older = { id: "older", createdAt: "2026-10-01", lastInteractedAt: null, pinnedAt: null };
  const newer = { ...older, id: "newer", createdAt: "2026-10-02" };
  const { result, rerender } = renderHook(({ rows }) => useSessionOrder(rows), {
    initialProps: { rows: [older, newer] as any[] },
  });
  const ids = () => result.current.map((t) => t.id);
  expect(ids()).toEqual(["newer", "older"]);
  const typed = { ...older, lastInteractedAt: "2026-10-03", title: "Updated title" };
  rerender({ rows: [typed, newer] });
  expect(ids()).toEqual(["newer", "older"]);
  expect(result.current[1]).toBe(typed);
  rerender({ rows: [{ ...typed, pinnedAt: "2026-10-03" }, newer] });
  expect(ids()).toEqual(["older", "newer"]);
  rerender({ rows: [typed, newer, { ...older, id: "fresh", createdAt: "2026-10-04" }] });
  expect(ids()).toEqual(["fresh", "newer", "older"]);
  rerender({ rows: [typed] });
  expect(ids()).toEqual(["older"]);
});
