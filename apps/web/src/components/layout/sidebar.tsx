"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { SidebarHeader, SidebarFooter } from "./sidebar-chrome";
import { SidebarNavigation } from "./sidebar-navigation";
import { useSidebarDrawer } from "./use-sidebar-drawer";

export function Sidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const sidebarRef = useRef<HTMLElement>(null);
  const onKeyDown = useSidebarDrawer(sidebarRef, open, onClose);
  return (
    <aside
      ref={sidebarRef}
      onKeyDown={onKeyDown}
      aria-label="Sidebar"
      className={cn(
        "w-60 shrink-0 border-r border-border/60 bg-bg-subtle flex flex-col",
        "fixed inset-y-0 left-0 z-30 transition-transform duration-200 md:static md:translate-x-0",
        open ? "visible translate-x-0" : "invisible -translate-x-full md:visible",
      )}
    >
      <SidebarHeader onNavigate={onClose} />
      <SidebarNavigation onNavigate={onClose} />
      <SidebarFooter onNavigate={onClose} />
    </aside>
  );
}
