import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { isPublicRoute } from "../plugins/auth.js";
import { cliDownloadRoutes, cliTarballPath, installServerOrigin } from "./cli-downloads.js";

const original = process.env.OPTIO_MCP_BRIDGE_DIST;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "optio-bridge-"));
});

afterEach(async () => {
  if (original === undefined) delete process.env.OPTIO_MCP_BRIDGE_DIST;
  else process.env.OPTIO_MCP_BRIDGE_DIST = original;
  await rm(dir, { recursive: true, force: true });
});

describe("the Optio CLI downloads", () => {
  const env = { tarball: process.env.OPTIO_CLI_TARBALL, publicApi: process.env.PUBLIC_API_URL };
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.PUBLIC_API_URL;
    delete process.env.PUBLIC_URL;
    app = await buildRouteTestApp(cliDownloadRoutes, { user: null });
  });

  afterEach(async () => {
    await app.close();
    if (env.tarball === undefined) delete process.env.OPTIO_CLI_TARBALL;
    else process.env.OPTIO_CLI_TARBALL = env.tarball;
    if (env.publicApi === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = env.publicApi;
  });

  it("are public routes", () => {
    expect(isPublicRoute("/api/cli/install.sh", "GET")).toBe(true);
    expect(isPublicRoute("/api/cli/optio-cli.tgz", "GET")).toBe(true);
  });

  it("serve install.sh using the operator-configured server rather than the request Host", async () => {
    process.env.PUBLIC_API_URL = "https://configured.example.com";
    const res = await app.inject({
      method: "GET",
      url: "/api/cli/install.sh",
      headers: { host: "optio.example.com:8443" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/x-shellscript/);
    expect(res.body).toMatch(/^#!\/bin\/sh\n/);
    expect(res.body).toContain("DEFAULT_SERVER='https://configured.example.com'");
    expect(res.body).toContain('OPTIO_SERVER="${OPTIO_SERVER:-$DEFAULT_SERVER}"');
    expect(res.body).toContain("/api/cli/optio-cli.tgz");
    expect(res.body).toContain('[ "$major" -ge 20 ]');
  });

  it("prefer the configured public URL, and never put a quote into the script", () => {
    expect(
      installServerOrigin(
        { protocol: "http", host: "internal:4000" },
        { PUBLIC_API_URL: "https://optio.example.com/api" },
      ),
    ).toBe("https://optio.example.com");
    expect(installServerOrigin({ protocol: "http", host: "evil'$(id)" }, {})).toBeNull();
    expect(installServerOrigin({ protocol: "http", host: "a.example" }, {})).toBeNull();
  });

  it("is a clear 404 when the deployment has no CLI bundle", async () => {
    process.env.OPTIO_CLI_TARBALL = path.join(dir, "missing.tgz");
    const res = await app.inject({ method: "GET", url: "/api/cli/optio-cli.tgz" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not available on this deployment/);
    expect(res.json().error).toMatch(/build-cli-tarball\.sh/);
    expect(cliTarballPath({})).toBe("/app/static/optio-cli.tgz");
  });

  it("installs a working optio command from the bundle, end to end", async () => {
    // A bundle in the real layout, with a stand-in for dist/optio.js.
    const src = path.join(dir, "src");
    await mkdir(path.join(src, "optio-cli", "dist"), { recursive: true });
    await writeFile(
      path.join(src, "optio-cli", "dist", "optio.js"),
      "console.log(process.argv.includes('--version') ? '9.9.9' : 'optio ' + process.argv.slice(2).join(' '));\n",
    );
    const tarball = path.join(dir, "optio-cli.tgz");
    execFileSync("tar", ["czf", tarball, "-C", src, "optio-cli"]);
    process.env.OPTIO_CLI_TARBALL = tarball;

    const served = await app.inject({ method: "GET", url: "/api/cli/optio-cli.tgz" });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("application/gzip");

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    process.env.PUBLIC_API_URL = address;
    const script = (await app.inject({ method: "GET", url: "/api/cli/install.sh" })).body;
    const home = path.join(dir, "home");
    await mkdir(home);
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "sh",
        ["-s"],
        { env: { PATH: process.env.PATH, HOME: home, OPTIO_SERVER: address } },
        (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
      );
      child.stdin!.end(script);
    });
    expect(out).toContain("Installed 9.9.9");
    const run = execFileSync(path.join(home, ".optio", "bin", "optio"), ["local", "up"], {
      encoding: "utf8",
    });
    expect(run.trim()).toBe("optio local up");
  });
});

describe("installer origin protection", () => {
  it("refuses a request Host fallback when the operator configured no public URL", async () => {
    const oldApi = process.env.PUBLIC_API_URL,
      oldUrl = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_API_URL;
    delete process.env.PUBLIC_URL;
    const app = await buildRouteTestApp(cliDownloadRoutes, { user: null });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/cli/install.sh",
        headers: { host: "attacker.example" },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatch(/PUBLIC_API_URL/);
      expect(res.body).not.toContain("attacker.example");
    } finally {
      await app.close();
      if (oldApi === undefined) delete process.env.PUBLIC_API_URL;
      else process.env.PUBLIC_API_URL = oldApi;
      if (oldUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = oldUrl;
    }
  });
});
