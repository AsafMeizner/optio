"use client";

import { create } from "zustand";

/** The page publishes its resolved session so the shell and rail agree on the active attempt. */
export const useWorkSession = create<{
  pathname: string | null;
  local: boolean;
  terminalId: string | null;
}>(() => ({ pathname: null, terminalId: null, local: false }));
