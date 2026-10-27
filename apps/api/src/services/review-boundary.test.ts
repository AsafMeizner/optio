import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  getRepoByUrl: vi.fn(),
  getGitPlatformForRepo: vi.fn(),
  createSubtask: vi.fn(),
  transitionTask: vi.fn(),
  add: vi.fn(),
}));
vi.mock("./task-service.js", () => ({
  getTask: mocks.getTask,
  transitionTask: mocks.transitionTask,
}));
vi.mock("./repo-service.js", () => ({ getRepoByUrl: mocks.getRepoByUrl }));
vi.mock("./git-token-service.js", () => ({ getGitPlatformForRepo: mocks.getGitPlatformForRepo }));
vi.mock("./subtask-service.js", () => ({ createSubtask: mocks.createSubtask }));
vi.mock("./optio-settings-service.js", () => ({ getSettings: vi.fn().mockResolvedValue(null) }));
vi.mock("../workers/task-worker.js", () => ({ taskQueue: { add: mocks.add } }));
import { launchReview } from "./review-service.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRepoByUrl.mockResolvedValue({ reviewModel: "sonnet" });
  mocks.createSubtask.mockResolvedValue({ id: "review-1" });
  mocks.getGitPlatformForRepo.mockResolvedValue({
    ri: {},
    platform: {
      getPullRequest: vi.fn().mockResolvedValue({ body: "PR" }),
      getReviews: vi.fn().mockResolvedValue([]),
      getIssueComments: vi.fn().mockResolvedValue([]),
      getInlineComments: vi.fn().mockResolvedValue([]),
    },
  });
});

it.each([null, "personal-owner"])(
  "resolves review configuration and Git access in the work's boundary (owner %s)",
  async (ownerUserId) => {
    mocks.getTask.mockResolvedValue({
      id: "parent",
      title: "A change",
      prompt: "Implement it",
      repoUrl: "https://github.com/org/repo",
      prUrl: "https://github.com/org/repo/pull/42",
      workspaceId: "tenant-b",
      ownerUserId,
      createdBy: "different-creator",
    });
    await launchReview("parent");
    expect(mocks.getRepoByUrl).toHaveBeenCalledWith("https://github.com/org/repo", "tenant-b");
    expect(mocks.getGitPlatformForRepo).toHaveBeenCalledWith("https://github.com/org/repo", {
      workspaceId: "tenant-b",
      userId: ownerUserId ?? undefined,
      server: !ownerUserId,
    });
  },
);
