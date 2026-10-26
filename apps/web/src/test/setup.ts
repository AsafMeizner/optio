import "@testing-library/jest-dom/vitest";

// Node 26 exposes host Web Storage globals. Vitest 3 preserves those globals
// instead of replacing them with jsdom's, even when Node has no storage file.
// Browser tests must use the current DOM's storage and Storage prototype.
const domWindow = (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window;
for (const key of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: domWindow[key],
  });
}
