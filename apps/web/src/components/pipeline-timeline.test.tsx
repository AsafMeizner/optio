import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Clock } from "lucide-react";
import { PipelineStageRow, PipelineTimeline, type StageStatus } from "./pipeline-timeline";
import { ReviewPipelineTimeline } from "./review-pipeline-timeline";
import { WorkflowRunPipelineTimeline } from "./workflow-run-pipeline-timeline";

afterEach(cleanup);

const time = (minute: number) => `2026-10-26T12:${String(minute).padStart(2, "0")}:00Z`;
const event = (toState: string, minute: number, trigger = "manual_start") => ({
  id: `event-${minute}`,
  toState,
  createdAt: time(minute),
  trigger,
});
const history = [event("queued", 0), event("provisioning", 1), event("running", 2)];

describe("task pipeline progress", () => {
  it.each([
    ["pending", "Queued"],
    ["queued", "Queued"],
    ["provisioning", "Setup"],
    ["running", "Running"],
    ["needs_attention", "Running"],
    ["unknown", "Queued"],
  ])("shows the active stage for %s without implying the PR has opened", (state, label) => {
    render(<PipelineTimeline task={{ state }} events={[]} subtasks={[]} />);
    expect(screen.getByText(label)).toHaveClass("text-primary");
    expect(screen.getByText("PR")).toHaveClass("text-text-muted/60");
    expect(screen.queryByText("Fixup")).not.toBeInTheDocument();
  });

  it.each([
    [{}, "PR"],
    [{ prChecksStatus: "pending" }, "CI Checks"],
    [{ prChecksStatus: "failing" }, "CI Checks"],
    [{ prChecksStatus: "passing" }, "Merge"],
    [{ prReviewStatus: "changes_requested" }, "Review"],
    [{ prReviewStatus: "approved", prChecksStatus: "passing" }, "Review"],
  ])("shows which post-PR action is blocking completion: %j", (detail, label) => {
    render(
      <PipelineTimeline
        task={{
          state: "pr_opened",
          prUrl: "https://github.com/acme/repo/pull/42",
          prNumber: 42,
          ...detail,
        }}
        events={[...history, event("pr_opened", 4)]}
        subtasks={[]}
      />,
    );
    expect(screen.getByText(label)).toHaveClass("text-primary");
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("Running")).toHaveClass("text-text");
  });

  it("shows an agent review after passing CI, even without a human review status", () => {
    render(
      <PipelineTimeline
        task={{ state: "pr_opened", prChecksStatus: "passing" }}
        events={[...history, event("pr_opened", 4)]}
        subtasks={[{ taskType: "review", state: "running" }]}
      />,
    );
    expect(screen.getByText("Review")).toHaveClass("text-primary");
    expect(screen.getByText("Agent running")).toBeInTheDocument();
  });

  it.each(["queued", "provisioning", "running"])(
    "keeps retry work at Fixup when it returns to %s after review feedback",
    (state) => {
      render(
        <PipelineTimeline
          task={{ state, prReviewStatus: "changes_requested", costUsd: "0.125" }}
          events={[...history, event("pr_opened", 4), event("needs_attention", 5), event(state, 6)]}
          subtasks={[{ taskType: "review", state: "completed" }]}
        />,
      );
      expect(screen.getByText("Fixup")).toHaveClass("text-primary");
      expect(screen.getByText("1 iteration")).toBeInTheDocument();
      expect(screen.getByText("Changes requested (agent completed)")).toBeInTheDocument();
      expect(screen.getByText("Cost: $0.1250")).toBeInTheDocument();
    },
  );

  it("counts feedback cycles after the PR, excluding earlier provisioning problems", () => {
    render(
      <PipelineTimeline
        task={{ state: "needs_attention" }}
        events={[
          event("needs_attention", 0),
          event("pr_opened", 2),
          event("needs_attention", 3),
          event("needs_attention", 4),
        ]}
        subtasks={[]}
      />,
    );
    expect(screen.getByText("2 iterations")).toBeInTheDocument();
    expect(screen.getByText("Review")).toHaveClass("text-primary");
  });

  it.each(["completed", "failed", "cancelled"])(
    "settles %s without an active progress indicator",
    (state) => {
      const { container } = render(
        <PipelineTimeline
          task={{ state, errorMessage: "Agent exited unexpectedly" }}
          events={[...history, event(state, 4)]}
          subtasks={[]}
        />,
      );
      expect(container.querySelector(".animate-ping")).toBeNull();
      if (state === "failed")
        expect(screen.getByText("Agent exited unexpectedly")).toBeInTheDocument();
      else expect(screen.queryByText("Agent exited unexpectedly")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["pending", "Queued"],
    ["queued", "Queued"],
    ["provisioning", "Setup"],
    ["running", "Reviewing"],
    ["needs_attention", "Reviewing"],
    ["unknown", "Queued"],
  ])("uses the shorter review-task pipeline for %s", (state, label) => {
    render(
      <PipelineTimeline task={{ state, taskType: "review" }} events={history} subtasks={[]} />,
    );
    expect(screen.getByText(label)).toHaveClass("text-primary");
    expect(screen.queryByText("PR")).not.toBeInTheDocument();
    expect(screen.queryByText("Merge")).not.toBeInTheDocument();
  });

  it.each(["completed", "failed", "cancelled"])("settles a %s review task", (state) => {
    const { container } = render(
      <PipelineTimeline
        task={{ state, taskType: "review" }}
        events={[...history, event(state, 5)]}
        subtasks={[]}
      />,
    );
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(container.querySelector(".animate-ping")).toBeNull();
  });

  it("keeps raw event history collapsed until requested and lets the user close it", () => {
    render(
      <PipelineTimeline
        task={{ state: "completed", prState: "merged" }}
        events={[event("running", 1), event("completed", 5, "pr_merged")]}
        subtasks={[]}
      />,
    );
    expect(screen.queryByText("pr merged")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Raw Events (2)" }));
    expect(screen.getByText("pr merged")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Raw Events (2)" }));
    expect(screen.queryByText("pr merged")).not.toBeInTheDocument();
  });
});

describe("pipeline row visibility", () => {
  it.each<StageStatus>(["active", "completed", "failed", "cancelled", "upcoming", "skipped"])(
    "only exposes applicable timing/error details for %s stages",
    (status) => {
      const { container } = render(
        <PipelineStageRow
          isLast={status === "completed"}
          stage={{
            id: "custom",
            label: "Stage",
            icon: Clock,
            status,
            timestamp: time(1),
            detail: "More information",
            duration: "3m 0s",
            errorMessage: "Private failure detail",
          }}
        />,
      );
      expect(!!container.querySelector(".animate-ping")).toBe(status === "active");
      expect(!!screen.queryByText("More information")).toBe(status !== "skipped");
      expect(!!screen.queryByText("3m 0s")).toBe(status === "completed");
      expect(!!screen.queryByText("Private failure detail")).toBe(status === "failed");
    },
  );
});

describe("PR review pipeline", () => {
  it.each([
    ["queued", "Queued"],
    ["waiting_ci", "Waiting for CI"],
    ["reviewing", "Agent reviewing"],
    ["ready", "Ready for review"],
  ])("identifies the active stage for %s", (state, label) => {
    render(
      <ReviewPipelineTimeline
        review={{ state, createdAt: time(0), updatedAt: time(3) }}
        runs={[]}
      />,
    );
    expect(screen.getByText(label)).toHaveClass("text-primary");
    if (state === "waiting_ci")
      expect(screen.getByText("Holding for required checks")).toBeInTheDocument();
  });

  it("flags a stale review and summarizes prior attempts", () => {
    render(
      <ReviewPipelineTimeline
        review={{ state: "stale", updatedAt: time(5) }}
        runs={[
          { startedAt: time(3), completedAt: time(4), costUsd: "0.5" },
          { startedAt: time(1) },
        ]}
      />,
    );
    expect(screen.getByText("Ready (stale)")).toHaveClass("text-warning");
    expect(screen.getByText("PR has new commits since this review")).toBeInTheDocument();
    expect(screen.getByText("2 runs · $0.5000")).toBeInTheDocument();
  });

  it("shows submitted reviews as completed, including automatic submission", () => {
    const { container } = render(
      <ReviewPipelineTimeline
        review={{ state: "submitted", autoSubmitted: true, submittedAt: time(5) }}
        runs={[{ createdAt: time(1) }]}
      />,
    );
    expect(screen.getByText("Submitted")).toHaveClass("text-text");
    expect(screen.getByText("Auto-submitted")).toBeInTheDocument();
    expect(screen.getByText("1 run")).toBeInTheDocument();
    expect(container.querySelector(".animate-ping")).toBeNull();
  });

  it.each([false, true])(
    "locates failure and cancellation before/after agent start (%s)",
    (started) => {
      const runs = [
        {
          state: "failed",
          ...(started ? { startedAt: time(1) } : {}),
          errorMessage: "Provider unavailable",
        },
      ];
      const { rerender, container } = render(
        <ReviewPipelineTimeline review={{ state: "failed" }} runs={runs} />,
      );
      expect(screen.getByText("Provider unavailable")).toBeInTheDocument();
      rerender(<ReviewPipelineTimeline review={{ state: "cancelled" }} runs={runs} />);
      expect(screen.queryByText("Provider unavailable")).not.toBeInTheDocument();
      expect(container.querySelector(".animate-ping")).toBeNull();
    },
  );

  it("shows a review-level failure even without a run record", () => {
    render(
      <ReviewPipelineTimeline
        review={{ state: "failed", errorMessage: "Repository inaccessible" }}
        runs={[]}
      />,
    );
    expect(screen.getByText("Repository inaccessible")).toBeInTheDocument();
  });
});

describe("Job run pipeline", () => {
  it.each([
    ["queued", "Queued"],
    ["provisioning", "Provisioning pod"],
    ["running", "Agent running"],
  ])("marks %s as active", (state, label) => {
    render(<WorkflowRunPipelineTimeline run={{ state }} />);
    expect(screen.getByText(label)).toHaveClass("text-primary");
  });

  it("keeps model, cost and retry context after successful completion", () => {
    render(
      <WorkflowRunPipelineTimeline
        run={{
          state: "completed",
          createdAt: time(0),
          startedAt: time(1),
          finishedAt: time(3),
          modelUsed: "sonnet",
          costUsd: "0.25",
          retryCount: 2,
        }}
      />,
    );
    expect(screen.getByText("Completed")).toHaveClass("text-text");
    expect(screen.getByText("sonnet · $0.2500 · retry 2")).toBeInTheDocument();
  });

  it.each([false, true])(
    "shows failed/cancelled outcomes before/after execution (%s)",
    (started) => {
      const run = {
        state: "failed",
        createdAt: time(0),
        ...(started ? { startedAt: time(1) } : {}),
        errorMessage: "Run stopped",
      };
      const { rerender, container } = render(<WorkflowRunPipelineTimeline run={run} />);
      expect(screen.getByText("Failed")).toHaveClass("text-warning");
      expect(!!screen.queryByText("Run stopped")).toBe(started);
      rerender(<WorkflowRunPipelineTimeline run={{ ...run, state: "cancelled" }} />);
      expect(screen.getByText("Cancelled")).toBeInTheDocument();
      expect(screen.queryByText("Run stopped")).not.toBeInTheDocument();
      expect(container.querySelector(".animate-ping")).toBeNull();
    },
  );

  it("does not invent an active stage for an unfamiliar server state", () => {
    const { container } = render(<WorkflowRunPipelineTimeline run={{ state: "future-state" }} />);
    expect(screen.getByText("Done")).toHaveClass("text-text-muted/60");
    expect(container.querySelector(".animate-ping")).toBeNull();
  });
});
