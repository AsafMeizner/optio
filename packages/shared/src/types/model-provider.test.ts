import { describe, expect, it } from "vitest";
import {
  bedrockDefaultModels,
  bedrockInferencePrefix,
  bedrockRuntime,
  canManageOrgResources,
  isModelProviderAgent,
  isValidAwsProfileName,
  isValidAwsRegion,
  modelProviderIdFrom,
} from "./model-provider.js";
import { secretCredentialId, secretIdFromCredential } from "./agent-credential.js";

describe("provider and credential input boundaries", () => {
  it("accepts only supported provider runtimes", () => {
    expect(isModelProviderAgent("claude-code")).toBe(true);
    expect(isModelProviderAgent("codex")).toBe(true);
    expect(isModelProviderAgent("terminal")).toBe(false);
  });
  it.each([
    undefined,
    null,
    {},
    { modelProvider: null },
    { modelProvider: 42 },
    { modelProvider: "  " },
  ])("ignores absent or malformed model provider selection %j", (options) => {
    expect(modelProviderIdFrom(options)).toBeUndefined();
  });
  it("trims an explicit provider id", () => {
    expect(modelProviderIdFrom({ modelProvider: " provider-id " })).toBe("provider-id");
  });
  it.each(["us-east-1", "us-gov-west-1", "ap-southeast-2"])("accepts region %s", (region) => {
    expect(isValidAwsRegion(region)).toBe(true);
  });
  it.each(["us-east-1;curl attacker", "$(id)", " US-east-1", "us-east"])(
    "rejects malformed region %s",
    (region) => {
      expect(isValidAwsRegion(region)).toBe(false);
    },
  );
  it("bounds profile names and rejects shell/config delimiters", () => {
    for (const name of ["production", "User+ops@example.com", "a".repeat(64)])
      expect(isValidAwsProfileName(name)).toBe(true);
    for (const name of [
      "",
      "a".repeat(65),
      "../prod",
      "prod\nrole_arn=other",
      "$(id)",
      "prod account",
    ])
      expect(isValidAwsProfileName(name)).toBe(false);
  });
  it.each(["member", "viewer", null, undefined] as const)(
    "does not grant organization administration to %s",
    (role) => {
      expect(canManageOrgResources(role)).toBe(false);
    },
  );
  it("grants organization administration to admins", () => {
    expect(canManageOrgResources("admin")).toBe(true);
  });
  it("recognizes only explicitly selected secret credentials", () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    expect(secretCredentialId(id)).toBe(`secret:${id}`);
    expect(secretIdFromCredential(`  secret:${id}  `)).toBe(id);
    for (const value of [
      null,
      undefined,
      {},
      3,
      id,
      `provider:${id}`,
      `secret:${id};curl attacker`,
      "secret:",
    ])
      expect(secretIdFromCredential(value)).toBeNull();
  });
});

describe("Bedrock runtime credentials", () => {
  it("ambient auth emits no stored credentials or profile", () => {
    expect(bedrockRuntime("claude-code", { region: "us-west-2" })).toEqual({
      env: {
        AWS_REGION: "us-west-2",
        AWS_DEFAULT_REGION: "us-west-2",
        CLAUDE_CODE_USE_BEDROCK: "1",
      },
      codexConfig: [],
    });
  });
  it("a local launch selects only its machine's profile", () => {
    expect(bedrockRuntime("codex", { region: "eu-west-1", awsProfile: "team" }, null)).toEqual({
      env: { AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1", AWS_PROFILE: "team" },
      codexConfig: ['model_provider="amazon-bedrock"'],
    });
  });
  it.each([undefined, "session-token"])(
    "includes an AWS session token only when supplied (%s)",
    (sessionToken) => {
      const runtime = bedrockRuntime(
        "codex",
        { region: "us-east-1" },
        { type: "access-key", accessKeyId: "access", secretAccessKey: "secret", sessionToken },
      );
      expect(runtime.env).toEqual({
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "access",
        AWS_SECRET_ACCESS_KEY: "secret",
        ...(sessionToken ? { AWS_SESSION_TOKEN: sessionToken } : {}),
      });
    },
  );
  it("keeps bearer credentials separate from AWS access-key credentials", () => {
    expect(
      bedrockRuntime(
        "claude-code",
        { region: "us-west-2" },
        { type: "bearer-token", bearerToken: "bearer" },
      ).env,
    ).toEqual({
      AWS_REGION: "us-west-2",
      AWS_DEFAULT_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
  });
  it.each([
    ["us-gov-west-1", "us-gov"],
    ["us-west-2", "us"],
    ["ca-central-1", "us"],
    ["eu-west-1", "eu"],
    ["ap-south-1", "apac"],
    ["sa-east-1", "global"],
  ])("maps %s to inference prefix %s", (region, prefix) => {
    expect(bedrockInferencePrefix(region)).toBe(prefix);
    expect(
      bedrockDefaultModels("claude-code", region).every((model) =>
        model.id.startsWith(`${prefix}.anthropic.`),
      ),
    ).toBe(true);
  });
  it("keeps OpenAI model ids independent of the inference region", () => {
    expect(bedrockDefaultModels("codex", "us-west-2")).toEqual(
      bedrockDefaultModels("codex", "eu-west-1"),
    );
    expect(
      bedrockDefaultModels("codex", "us-west-2").every((model) => model.id.startsWith("openai.")),
    ).toBe(true);
  });
});
