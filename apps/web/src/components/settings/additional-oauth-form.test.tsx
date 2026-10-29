import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SignInConfig, SignInProviderView } from "@/lib/api-client";
const saveSignInProvider = vi.fn();
const testSignInProvider = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    saveSignInProvider: (...a: unknown[]) => saveSignInProvider(...a),
    testSignInProvider: (...a: unknown[]) => testSignInProvider(...a),
    deleteSignInProvider: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { AdditionalOAuthForm } from "./additional-oauth-form";
const EMPTY_OIDC: SignInProviderView = {
  provider: "oidc",
  displayName: "SSO (OpenID Connect)",
  configurable: true,
  enabled: false,
  source: "none",
  clientId: null,
  hasClientSecret: false,
  allowedDomains: [],
  callbackUrl: "https://optio.example.com/api/auth/oidc/callback",
  updatedAt: null,
};
const adminConfig = (): SignInConfig => ({
  bootstrap: false,
  canEdit: true,
  canClaim: false,
  publicUrl: "https://optio.example.com",
  providers: [EMPTY_OIDC],
});
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => {
  saveSignInProvider.mockReset();
  testSignInProvider.mockReset();
});
afterEach(cleanup);

describe("additional OAuth settings", () => {
  it.each(["gitea", "bitbucket"] as const)(
    "saves %s client credentials without enabling email links by default",
    async (provider) => {
      const view: SignInProviderView = {
        ...EMPTY_OIDC,
        provider,
        displayName: provider === "gitea" ? "Gitea / Forgejo" : "Bitbucket",
      };
      saveSignInProvider.mockResolvedValue({
        provider: { ...view, enabled: true },
        bootstrap: false,
      });
      render(
        <AdditionalOAuthForm
          view={view}
          config={adminConfig()}
          setupToken=""
          mode="settings"
          onSaved={vi.fn()}
          onRemoved={vi.fn()}
        />,
      );
      type("Client ID", "client-id");
      type("Client secret", "client-secret");
      if (provider === "gitea") type("Gitea / Forgejo server URL", "https://git.example.test/code");
      fireEvent.submit(screen.getByRole("form", { name: `${view.displayName} settings` }));
      await waitFor(() => expect(saveSignInProvider).toHaveBeenCalledTimes(1));
      expect(saveSignInProvider.mock.calls[0][0]).toBe(provider);
      expect(saveSignInProvider.mock.calls[0][1]).toMatchObject({
        clientId: "client-id",
        clientSecret: "client-secret",
        settings: { linkByEmail: false },
      });
      if (provider === "gitea")
        expect(saveSignInProvider.mock.calls[0][1].settings.baseUrl).toBe(
          "https://git.example.test/code",
        );
      await waitFor(() => expect(screen.getByLabelText("Client secret")).toHaveValue(""));
    },
  );
});
