import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { USING_OPTIO_GUIDE } from "@/content/using-optio-guide";
import { GuideMarkdown, guideLink, slugify } from "./guide-markdown";

afterEach(() => cleanup());

describe("slugify (GitHub's and GitLab's heading anchors)", () => {
  it("lower case, punctuation dropped, spaces to hyphens", () => {
    expect(slugify("Sign in")).toBe("sign-in");
    expect(slugify("Review the pull request")).toBe("review-the-pull-request");
    expect(slugify("When something goes wrong?")).toBe("when-something-goes-wrong");
  });
});

describe("guideLink", () => {
  it("keeps anchors and web links; another doc stays text, named in the source", () => {
    expect(guideLink("#sign-in")).toEqual({ kind: "anchor", href: "#sign-in" });
    expect(guideLink("https://optio.example.com")).toEqual({
      kind: "external",
      href: "https://optio.example.com",
    });
    expect(guideLink("tasks.md")).toEqual({ kind: "doc", file: "docs/tasks.md" });
    expect(guideLink("observability.md#common-failures")).toEqual({
      kind: "doc",
      file: "docs/observability.md",
    });
    expect(guideLink("/settings")).toBeNull();
  });

  it("never makes a link of a script or data URL", () => {
    expect(guideLink("javascript:alert(1)")).toBeNull();
    expect(guideLink("JaVaScRiPt:alert(1)")).toBeNull();
    expect(guideLink("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(guideLink("vbscript:msgbox(1)")).toBeNull();
  });
});

describe("GuideMarkdown", () => {
  it("renders the guide with an id on every heading its contents link to", () => {
    const { container } = render(<GuideMarkdown source={USING_OPTIO_GUIDE} />);
    expect(screen.getByRole("heading", { level: 1, name: "Using Optio" })).toBeInTheDocument();
    const anchors = [...USING_OPTIO_GUIDE.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(5);
    for (const id of new Set(anchors)) {
      expect(container.querySelector(`[id="${id}"]`), `#${id}`).not.toBeNull();
    }
  });

  it("a link to another doc is text (that doc isn't served in the app)", () => {
    render(<GuideMarkdown source="See the [task states](tasks.md)." />);
    expect(screen.queryByRole("link", { name: "task states" })).not.toBeInTheDocument();
    expect(screen.getByText("task states")).toHaveAttribute(
      "title",
      "docs/tasks.md in the Optio source",
    );
  });

  it("an external link opens in a new tab without the opener", () => {
    render(<GuideMarkdown source="[Optio](https://optio.example.com)" />);
    const link = screen.getByRole("link", { name: "Optio" });
    expect(link).toHaveAttribute("href", "https://optio.example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders no raw HTML, no script link and no image", () => {
    const { container } = render(
      <GuideMarkdown
        source={[
          "<script>window.__pwned = true</script>",
          "",
          '<img src="x" onerror="window.__pwned = true">',
          "",
          '<a href="javascript:alert(1)">raw</a>',
          "",
          "[click](javascript:alert(1)) and [data](data:text/html,hi)",
          "",
          "![tracker](https://tracker.example.com/pixel.png)",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^(javascript|data):/i);
    }
    expect(screen.queryByRole("link", { name: "click" })).toBeNull();
    expect(screen.getByText(/click/)).toBeInTheDocument();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("renders the tables", () => {
    render(<GuideMarkdown source={USING_OPTIO_GUIDE} />);
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
  });
});
