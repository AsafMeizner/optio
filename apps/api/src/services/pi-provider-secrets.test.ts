import { expect, it, vi } from "vitest";
import { piProviderSecrets } from "./pi-provider-secrets.js";

it("accepts each supported provider on its own", async () => {
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"]) {
    expect(await piProviderSecrets(async (key) => (key === name ? "value" : null))).toEqual({
      [name]: "value",
    });
  }
});
it("uses only the explicit credential when one is selected", async () => {
  const lookup = vi.fn(async () => "ambient");
  expect(await piProviderSecrets(lookup, { env: { OPENAI_API_KEY: "chosen" } })).toEqual({
    OPENAI_API_KEY: "chosen",
  });
  expect(lookup).not.toHaveBeenCalled();
});
it("reports missing keys clearly", async () => {
  await expect(piProviderSecrets(async () => null)).rejects.toThrow("Pi needs one of");
});
