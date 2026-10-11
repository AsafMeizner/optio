"use client";

import { useEffect, type KeyboardEvent, type RefObject } from "react";

/** The dashboard and session drawers share keyboard focus and dismissal behavior. */
export function useSidebarDrawer(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose?: () => void,
) {
  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 767px)").matches) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = ref.current;
    sidebar?.querySelector<HTMLButtonElement>('[aria-label="Close menu"]')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, open, onClose]);

  // Handle keys in the same React event tree as the nested menus, so their
  // Escape handlers can dismiss just that menu and keep the drawer open.
  return (event: KeyboardEvent<HTMLElement>) => {
    if (!open || event.defaultPrevented || !window.matchMedia("(max-width: 767px)").matches) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
    }
    const sidebar = ref.current;
    if (event.key !== "Tab" || !sidebar) return;
    const targets = [
      ...sidebar.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, summary, [tabindex="0"]',
      ),
    ].filter((element) => element.getClientRects().length > 0);
    const first = targets[0];
    const last = targets[targets.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
}
