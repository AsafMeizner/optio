/** A GET /user GitLab fixture for commit-identity tests; all other routes fail. */
export function fakeGitLab(opts: {
  host: string;
  bot: { id: number; username: string; bot?: boolean };
  token?: string;
}) {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.pathname.replace(/^\/api\/v4/, "");
      calls.push(`${method} ${path}`);
      const headers = new Headers(init?.headers);
      const token =
        headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? headers.get("private-token");
      const status =
        url.host !== opts.host
          ? 404
          : opts.token && token !== opts.token
            ? 401
            : method === "GET" && path === "/user"
              ? 200
              : 404;
      return Response.json(status === 200 ? opts.bot : { message: `${status}` }, { status });
    }) as typeof fetch,
  };
}
