/** Capture installed Debug apps against the isolated demo. No device credentials are used. */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const m = JSON.parse(readFileSync("/tmp/optio-showcase-4965.json", "utf8"));
const simulator = process.env.OPTIO_SHOWCASE_SIMULATOR;
if (!simulator)
  throw new Error("Set OPTIO_SHOWCASE_SIMULATOR to an installed iPhone simulator UUID");
const emulator = process.env.OPTIO_SHOWCASE_EMULATOR ?? "emulator-5562";
if (!/^emulator-\d+$/.test(emulator))
  throw new Error("Screenshots require an isolated Android emulator");
const adb = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
// Use an explicit tunnel to the private lab, including on Android versions that
// restrict local-network access. Nothing is forwarded to the user's real API.
execFileSync(adb, ["-s", emulator, "reverse", "tcp:4965", "tcp:4965"]);
execFileSync(adb, ["-s", emulator, "shell", "cmd", "uimode", "night", "yes"], { stdio: "ignore" });

async function waitForAndroidScreen(name) {
  const expected = {
    work: "Polish the checkout experience",
    recurring: "Keep dependencies current",
    session: "Ready for your review",
    "new-work": "What starts it?",
  }[name];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    execFileSync(
      adb,
      ["-s", emulator, "shell", "uiautomator", "dump", "/sdcard/optio-showcase.xml"],
      { stdio: "ignore", timeout: 10000 },
    );
    const tree = execFileSync(adb, ["-s", emulator, "shell", "cat", "/sdcard/optio-showcase.xml"], {
      encoding: "utf8",
    });
    if (tree.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Android ${name} did not show its expected demo content; refusing to capture a loading screen.`,
  );
}

// The capture target is an isolated demo emulator. Keep system alerts out of the tour.
for (const args of [
  ["settings", "put", "global", "heads_up_notifications_enabled", "0"],
  ["settings", "put", "global", "sysui_demo_allowed", "1"],
  ["am", "broadcast", "-a", "com.android.systemui.demo", "--es", "command", "enter"],
  [
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "--es",
    "command",
    "clock",
    "--es",
    "hhmm",
    "0941",
  ],
  [
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "--es",
    "command",
    "notifications",
    "--es",
    "visible",
    "false",
  ],
  [
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "--es",
    "command",
    "battery",
    "--es",
    "level",
    "100",
    "--es",
    "plugged",
    "false",
  ],
]) {
  execFileSync(adb, ["-s", emulator, "shell", ...args], { stdio: "ignore" });
}
const out = "/tmp/optio-showcase-shots";
mkdirSync(out, { recursive: true });
const pause = () => new Promise((r) => setTimeout(r, 4500));
const iosEnv = {
  ...process.env,
  SIMCTL_CHILD_OPTIO_DEV_SERVER_URL: m.api,
  SIMCTL_CHILD_OPTIO_DEV_TOKEN: "demo",
  SIMCTL_CHILD_OPTIO_DEV_SERVER_NAME: "Optio demo",
  SIMCTL_CHILD_OPTIO_DEV_NO_PUSH_PROMPT: "1",
};
// A fresh launch opens Overview before we navigate through the Work screens.
execFileSync(
  "xcrun",
  ["simctl", "launch", "--terminate-running-process", simulator, "dev.optio.ios"],
  { env: iosEnv, stdio: "ignore" },
);
await pause();
execFileSync("xcrun", ["simctl", "io", simulator, "screenshot", `${out}/ios-overview.png`], {
  stdio: "ignore",
});
const screens = [
  ["work", "optio://section/work?view=active"],
  ["recurring", "optio://section/work?view=recurring"],
  ["session", `optio://local/${m.live.claude}`],
  ["new-work", "optio://work/new"],
];
for (const [name, url] of screens) {
  execFileSync(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", simulator, "dev.optio.ios"],
    {
      env: {
        ...iosEnv,
        SIMCTL_CHILD_OPTIO_DEV_OPEN_URL: url,
        ...(name === "new-work"
          ? {
              SIMCTL_CHILD_OPTIO_DEV_NEW_SESSION: "schedule",
              SIMCTL_CHILD_OPTIO_DEV_NEW_SESSION_TWEAKS:
                "prompt=Prepare a daily engineering briefing for review,name=Morning engineering briefing",
            }
          : {}),
      },
      stdio: "ignore",
    },
  );
  const extras = [
    "--es",
    "OPTIO_DEV_SERVER_URL",
    "http://127.0.0.1:4965",
    "--es",
    "OPTIO_DEV_TOKEN",
    "demo",
    "--es",
    "OPTIO_DEV_OPEN_URL",
    url,
  ];
  if (name === "new-work")
    extras.push(
      "--es",
      "OPTIO_DEV_NEW_WORK",
      "schedule",
      "--es",
      "OPTIO_DEV_NEW_WORK_TWEAKS",
      "prompt=Prepare a daily engineering briefing for review,name=Morning engineering briefing",
    );
  execFileSync(
    adb,
    [
      "-s",
      emulator,
      "shell",
      "am",
      "start",
      "-S",
      "-n",
      "dev.optio.android/dev.optio.app.MainActivity",
      ...extras,
    ],
    { stdio: "ignore" },
  );
  await pause();
  await waitForAndroidScreen(name);
  execFileSync("xcrun", ["simctl", "io", simulator, "screenshot", `${out}/ios-${name}.png`], {
    stdio: "ignore",
  });
  writeFileSync(
    `${out}/android-${name}.png`,
    execFileSync(adb, ["-s", emulator, "exec-out", "screencap", "-p"], {
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  console.log(`iOS + Android: ${name}`);
}
