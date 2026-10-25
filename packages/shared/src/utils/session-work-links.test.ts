import { describe, expect, it } from "vitest";
import { createPodLinkScanner, mergePodWorkLinks } from "./session-work-links.js";
import { extractWorkLinks, MAX_WORK_LINKS } from "./extract-work-links.js";

describe("pod session links", () => {
  it("finds ANSI-colored links and OSC 8 hyperlinks split across terminal frames", () => {
    const scan = createPodLinkScanner("https://github.com/acme/app");
    expect(scan("\x1b[32mhttps://github.com/acme/app/pu", 120)).toEqual([]);
    const links = scan(
      "ll/123\x1b[0m\n\x1b]8;;https://linear.app/acme/issue/ENG-9\x07ticket\x1b]8;;\x07\n",
      120,
    );
    expect(links.map((l) => l.label)).toEqual(["acme/app#123", "ENG-9"]);
    expect(scan("\nSee #123 and #45\n", 120).map((l) => l.label)).toEqual([
      "acme/app#123",
      "ENG-9",
      "#45",
    ]);
  });

  it("deduplicates chat, terminal and recorded PRs and upgrades bare references", () => {
    const scan = createPodLinkScanner("https://github.com/acme/app");
    const refs = scan("See #25\n", 80);
    const prs = extractWorkLinks("https://github.com/acme/app/pull/25");
    expect(mergePodWorkLinks(refs, prs)).toEqual(prs);
    expect(mergePodWorkLinks(prs, prs)).toEqual(prs);
  });

  it("does not join a short line's PR number to digits on the next line", () => {
    const scan = createPodLinkScanner();
    expect(
      scan("https://github.com/acme/app/pull/123\n19 files changed\n", 120).map((l) => l.url),
    ).toEqual(["https://github.com/acme/app/pull/123"]);
  });

  it("bounds saved links even across many chunks", () => {
    const scan = createPodLinkScanner();
    let links = scan("", 80);
    for (let n = 1; n <= MAX_WORK_LINKS + 20; n++) {
      links = scan(`https://github.com/acme/app/pull/${n}\n`, 80);
    }
    expect(links).toHaveLength(MAX_WORK_LINKS);
  });
});

it("does not save a truncated PR number when frames split inside the number", () => {
  const scan = createPodLinkScanner();
  expect(scan("https://github.com/acme/app/pull/1", 80)).toEqual([]);
  expect(scan("23\n", 80).map((l) => l.url)).toEqual(["https://github.com/acme/app/pull/123"]);
});

it("flushes an unterminated link when the stream closes", () => {
  const scan = createPodLinkScanner();
  expect(scan("https://github.com/acme/app/pull/123", 80)).toEqual([]);
  expect(scan("", 80, true)).toHaveLength(1);
});
