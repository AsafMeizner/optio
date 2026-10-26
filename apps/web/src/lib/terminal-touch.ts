import type { Terminal as XTerm } from "@xterm/xterm";

export function installTouchWheel(term: XTerm, container: HTMLElement): () => void {
  let lastY: number | null = null;
  let lastX = 0;
  let pending = 0;
  const cellHeight = () => {
    const h = (term as any)._core?._renderService?.dimensions?.css?.cell?.height;
    return h > 0 ? h : 17;
  };
  const onStart = (e: TouchEvent) => {
    lastY = e.touches.length === 1 ? e.touches[0]!.clientY : null;
    lastX = e.touches.length === 1 ? e.touches[0]!.clientX : 0;
    pending = 0;
  };
  const onMove = (e: TouchEvent) => {
    if (lastY === null || e.touches.length !== 1 || term.modes.mouseTrackingMode === "none") {
      return;
    }
    const y = e.touches[0]!.clientY;
    // Finger up = further down the conversation, as with native scrolling.
    pending += lastY - y;
    lastY = y;
    e.preventDefault();
    const step = cellHeight();
    const target = term.element?.querySelector(".xterm-screen") ?? term.element;
    // One wheel event per line moved, a few at most per frame.
    for (let n = 0; Math.abs(pending) >= step && n < 5; n++) {
      const deltaY = pending > 0 ? step : -step;
      pending -= deltaY;
      target?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          clientX: lastX,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };
  const onEnd = () => {
    lastY = null;
  };
  container.addEventListener("touchstart", onStart, { passive: true });
  container.addEventListener("touchmove", onMove, { passive: false });
  container.addEventListener("touchend", onEnd, { passive: true });
  container.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    container.removeEventListener("touchstart", onStart);
    container.removeEventListener("touchmove", onMove);
    container.removeEventListener("touchend", onEnd);
    container.removeEventListener("touchcancel", onEnd);
  };
}
