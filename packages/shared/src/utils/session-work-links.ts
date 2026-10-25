import {
  dedupeWorkLinks,
  extractHyperlinkUrls,
  extractWorkLinks,
  MAX_WORK_LINKS,
  type WorkLink,
} from "./extract-work-links.js";

/** Keep a bounded tail so links split across terminal frames can be recognized. */
export function createPodLinkScanner(repoUrl?: string) {
  let tail = "";
  let links: WorkLink[] = [];
  return (chunk: string, wrapWidth: number, final = false): WorkLink[] => {
    tail = (tail + chunk).slice(-65536);
    // Harvest OSC 8 destinations before removing terminal control sequences.
    const urls = extractHyperlinkUrls(tail);
    const plain = tail.replace(
      /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g,
      "",
    );
    // An unterminated URL may be cut inside its number at a frame boundary.
    // Wait for its delimiter (or stream close) rather than recording a shorter PR.
    const complete = final ? plain : plain.replace(/(?:https?:\/\/[^\s<>()"'`]*|#\d+)$/, "");
    links = dedupeWorkLinks([
      ...links,
      ...extractWorkLinks(complete, { repoUrl, wrapWidth }),
      ...extractWorkLinks(urls.join("\n"), { repoUrl, wrapWidth: Infinity }),
    ]).slice(0, MAX_WORK_LINKS);
    return links;
  };
}

export function mergePodWorkLinks(previous: WorkLink[], incoming: WorkLink[]): WorkLink[] {
  return dedupeWorkLinks([...previous, ...incoming]).slice(0, MAX_WORK_LINKS);
}
