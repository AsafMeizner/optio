import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  onboarding: false,
  loaded: true,
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: vi.fn() }));
vi.mock("@/hooks/use-onboarding", () => ({
  useOnboarding: () => ({ onboarding: mocks.onboarding, loaded: mocks.loaded }),
}));
vi.mock("@/components/help/guide-markdown", () => ({
  GuideMarkdown: ({ source }: { source: string }) => (
    <div data-testid="guide">{source.slice(0, 40)}</div>
  ),
}));

import HelpPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.onboarding = false;
  mocks.loaded = true;
});

describe("/help", () => {
  it("doesn't exist with the getting-started guide off (the default): Not found", () => {
    expect(() => render(<HelpPage />)).toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalled();
    expect(screen.queryByTestId("guide")).toBeNull();
  });

  it("shows the guide, without its own title, with the getting-started guide on", () => {
    mocks.onboarding = true;
    render(<HelpPage />);
    expect(screen.getByTestId("guide")).toBeInTheDocument();
    expect(screen.getByTestId("guide").textContent).not.toMatch(/^# Using Optio/);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("shows nothing until the switch is known", () => {
    mocks.loaded = false;
    const { container } = render(<HelpPage />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});
