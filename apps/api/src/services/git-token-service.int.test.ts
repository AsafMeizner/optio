/**
 * Integration test — `isTrustedGitHost` against the real `repos` table: the
 * deployment's git token only goes to a host an admin registered a repo on.
 */
import { describe, expect, it } from "vitest";
import { isTrustedGitHost } from "./git-token-service.js";
import { insertRepo } from "../test-utils/integration/fixtures.js";

describe("isTrustedGitHost (registered repo hosts)", () => {
  it("trusts a host with a registered repo, and only that exact host", async () => {
    await insertRepo({ repoUrl: "https://ghexcorp.example/acme/app", fullName: "acme/app" });

    expect(await isTrustedGitHost({ host: "ghexcorp.example", platform: "github" })).toBe(true);
    expect(await isTrustedGitHost({ host: "GHEXCORP.example", platform: "github" })).toBe(true);
    // LIKE wildcards in the host are literal, and a suffix is a different host.
    expect(await isTrustedGitHost({ host: "ghe_corp.example", platform: "github" })).toBe(false);
    expect(await isTrustedGitHost({ host: "xcorp.example", platform: "github" })).toBe(false);
    expect(await isTrustedGitHost({ host: "ghexcorp.example.evil", platform: "github" })).toBe(
      false,
    );
    expect(await isTrustedGitHost({ host: "attacker.example", platform: "gitlab" })).toBe(false);
  });
});
