import manifest from "../../public/screenshots/showcase/manifest.json";

/** Use capture dimensions rather than assuming a device or browser aspect ratio. */
export function Screenshot({
  file,
  alt,
  eager = false,
}: {
  file: string;
  alt: string;
  eager?: boolean;
}) {
  const capture = manifest.images.find((image) => image.file === `${file}.webp`);
  if (!capture) throw new Error(`Screenshot missing from capture manifest: ${file}`);

  return (
    <img
      className="screenshot"
      src={`/screenshots/showcase/${capture.file}`}
      alt={alt}
      width={capture.width}
      height={capture.height}
      decoding="async"
      loading={eager ? "eager" : "lazy"}
      fetchPriority={eager ? "high" : "auto"}
    />
  );
}
