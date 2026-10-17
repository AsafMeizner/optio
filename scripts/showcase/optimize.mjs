/** Optimize captures without redrawing or changing the product UI. Requires cwebp. */
import { execFileSync } from "node:child_process";
import { readdirSync, mkdirSync, statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
const source = "/tmp/optio-showcase-shots";
const dest = "apps/site/public/screenshots/showcase";
mkdirSync(dest, { recursive: true });
const manifestPath = `${dest}/manifest.json`;
const previous = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { images: [] };
const captured = new Date().toISOString().slice(0, 10);
const imagesByFile = new Map(
  previous.images.map((image) => [
    image.file,
    {
      ...image,
      captured: image.captured ?? previous.captured,
    },
  ]),
);
let updated = 0;
for (const file of readdirSync(source)
  .filter((f) => f.endsWith(".png"))
  .sort()) {
  const target = file.replace(/\.png$/, ".webp");
  execFileSync("cwebp", [
    "-quiet",
    "-q",
    "88",
    "-m",
    "6",
    "-sharp_yuv",
    `${source}/${file}`,
    "-o",
    `${dest}/${target}`,
  ]);
  const png = readFileSync(`${source}/${file}`);
  imagesByFile.set(target, {
    captured,
    file: target,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bytes: statSync(`${dest}/${target}`).size,
  });
  updated++;
}
const images = [...imagesByFile.values()].sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      captured,
      content:
        "Fictional example data. Live session activity and usage are simulated. Screens are rendered by the real web, SwiftUI, and Jetpack Compose apps. Apple glance surfaces are native component snapshots.",
      images,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Updated ${updated} of ${images.length} screenshots: ${(images.reduce((n, i) => n + i.bytes, 0) / 1024 / 1024).toFixed(2)} MiB total.`,
);
