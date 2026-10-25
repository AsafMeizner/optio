import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsLayout } from "./settings-layout";

let resize: () => void;
const scrollIntoView = vi.fn();
const disconnect = vi.fn();
const sections = [
  { id: "access", title: "Access", description: "Access settings", content: <input /> },
  {
    id: "integrations",
    title: "Integrations",
    description: "Connected services",
    content: <input />,
  },
];

beforeEach(() => {
  window.history.replaceState(null, "", "/settings");
  vi.clearAllMocks();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  window.history.replaceState(null, "", "/");
});

describe("SettingsLayout hash navigation", () => {
  it("keeps an initial deep link aligned when content resizes", () => {
    window.history.replaceState(null, "", "/settings#integrations");
    render(<SettingsLayout sections={sections} />);
    scrollIntoView.mockClear();
    resize();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById("integrations"));
  });

  it("follows hash changes and releases the previous target for an unknown hash", () => {
    render(<SettingsLayout sections={sections} />);
    window.history.replaceState(null, "", "/settings#integrations");
    fireEvent(window, new HashChangeEvent("hashchange"));
    scrollIntoView.mockClear();
    resize();
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById("integrations"));
    window.history.replaceState(null, "", "/settings#unknown");
    fireEvent(window, new HashChangeEvent("hashchange"));
    scrollIntoView.mockClear();
    resize();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("stops following a deep link after the user scrolls", () => {
    window.history.replaceState(null, "", "/settings#integrations");
    render(<SettingsLayout sections={sections} />);
    fireEvent.wheel(window);
    scrollIntoView.mockClear();
    resize();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("still follows a clicked section", () => {
    render(<SettingsLayout sections={sections} />);
    const link = screen.getByRole("link", { name: "Integrations" });
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    resize();
    expect(scrollIntoView.mock.instances[0]).toBe(document.getElementById("integrations"));
  });

  it("removes the hash listener on unmount", () => {
    const { unmount } = render(<SettingsLayout sections={sections} />);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    const target = document.createElement("section");
    target.id = "integrations";
    document.body.append(target);
    window.history.replaceState(null, "", "/settings#integrations");
    fireEvent(window, new HashChangeEvent("hashchange"));
    target.remove();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
