/** Capture the real iOS UI with fictional showcase data for App Store Connect. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [manifestPath, simulator, outputPath] = process.argv.slice(2);
if (!manifestPath || !simulator || !outputPath) {
  throw new Error(
    "Usage: node capture-store-screenshots.mjs <showcase.json> <simulator UUID> <output>",
  );
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const server = new URL(manifest.api);
if (
  server.protocol !== "http:" ||
  server.hostname !== "127.0.0.1" ||
  Number(server.port) < 4962 ||
  Number(server.port) > 4979 ||
  !manifest.live?.claude
) {
  throw new Error("Start the isolated showcase lab and playback before capture.");
}
const simctl = (...args) =>
  execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8", timeout: 120_000 });
const devices = JSON.parse(simctl("list", "devices", "--json")).devices;
const device = Object.values(devices)
  .flat()
  .find((item) => item.udid === simulator);
if (!device || device.state !== "Booted") throw new Error("A booted iOS simulator is required.");
const container = simctl("get_app_container", simulator, "dev.optio.ios", "app").trim();
const info = JSON.parse(
  execFileSync("plutil", ["-convert", "json", "-o", "-", join(container, "Info.plist")], {
    encoding: "utf8",
  }),
);
const output = resolve(outputPath);
mkdirSync(output, { recursive: true });
const screens = [
  ["01-overview", null],
  ["02-work", "optio://section/work?view=active"],
  ["03-recurring", "optio://section/work?view=recurring"],
  ["04-agent-conversation", `optio://local/${manifest.live.claude}`],
  ["05-new-work", "optio://work/new"],
];
simctl("ui", simulator, "appearance", "light");
simctl(
  "status_bar",
  simulator,
  "override",
  "--time",
  "9:41",
  "--dataNetwork",
  "wifi",
  "--wifiMode",
  "active",
  "--wifiBars",
  "3",
  "--batteryState",
  "charged",
  "--batteryLevel",
  "100",
);
try {
  for (const [name, url] of screens) {
    execFileSync(
      "xcrun",
      ["simctl", "launch", "--terminate-running-process", simulator, "dev.optio.ios"],
      {
        stdio: "ignore",
        timeout: 120_000,
        env: {
          ...process.env,
          SIMCTL_CHILD_OPTIO_DEV_SERVER_URL: manifest.api,
          SIMCTL_CHILD_OPTIO_DEV_TOKEN: "demo",
          SIMCTL_CHILD_OPTIO_DEV_SERVER_NAME: "Optio demo",
          SIMCTL_CHILD_OPTIO_DEV_NO_PUSH_PROMPT: "1",
          SIMCTL_CHILD_OPTIO_DEV_SECTION: "overview",
          SIMCTL_CHILD_OPTIO_DEV_OPEN_URL: url ?? "",
          SIMCTL_CHILD_OPTIO_DEV_NEW_SESSION: url === "optio://work/new" ? "schedule" : "",
          SIMCTL_CHILD_OPTIO_DEV_NEW_SESSION_TWEAKS:
            url === "optio://work/new"
              ? "prompt=Prepare a daily engineering briefing for review,name=Morning engineering briefing"
              : "",
        },
      },
    );
    await new Promise((done) => setTimeout(done, 6500));
    // Capture JPEG directly: App Store Connect requires images without alpha.
    simctl("io", simulator, "screenshot", "--type=jpeg", join(output, `${name}.jpg`));
    console.log(`Captured ${device.name}: ${name}`);
  }
  writeFileSync(
    join(output, "capture.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        device: device.name,
        simulator,
        appVersion: info.CFBundleShortVersionString,
        buildNumber: info.CFBundleVersion,
        source: "Unmodified simulator captures of the native app with fictional showcase data",
        server: manifest.api,
        files: screens.map(([name]) => `${name}.jpg`),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  simctl("status_bar", simulator, "clear");
}
