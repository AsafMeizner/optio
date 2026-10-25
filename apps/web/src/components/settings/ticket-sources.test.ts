import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect } from "vitest";
import { ticketSourceOptions } from "./ticket-sources";

// Settings → Tickets' upstream list (app/settings/page.tsx TICKET_SOURCES).
const UPSTREAM = [
  { value: "github", label: "GitHub Issues" },
  { value: "jira", label: "Jira" },
  { value: "linear", label: "Linear" },
  { value: "notion", label: "Notion" },
];

describe("ticketSourceOptions", () => {
  it("adds GitLab Issues to upstream's list under the default deployment", () => {
    expect(ticketSourceOptions(UPSTREAM, featuresFromEnv({}))).toEqual([
      ...UPSTREAM,
      { value: "gitlab", label: "GitLab Issues" },
    ]);
  });

  it("offers Jira and GitLab Issues under the restricted deployment", () => {
    expect(
      ticketSourceOptions(
        UPSTREAM,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual([
      { value: "jira", label: "Jira" },
      { value: "gitlab", label: "GitLab Issues" },
    ]);
  });
});
