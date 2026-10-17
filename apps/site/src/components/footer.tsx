import Link from "next/link";
import Image from "next/image";

const github = "https://github.com/jonwiggins/optio";
const groups = [
  {
    title: "Explore",
    links: [
      { title: "Product tour", href: "/#product" },
      { title: "How it works", href: "/platform" },
      { title: "Mobile apps", href: "/#mobile" },
    ],
  },
  {
    title: "Build",
    links: [
      { title: "Get started", href: "/docs/getting-started" },
      { title: "Deployment", href: "/docs/deployment" },
      { title: "API reference", href: "/docs/api-reference" },
    ],
  },
  {
    title: "Open source",
    links: [
      { title: "GitHub", href: github },
      { title: "Contributing", href: "/docs/contributing" },
      { title: "Releases", href: `${github}/releases` },
      { title: "MIT license", href: `${github}/blob/main/LICENSE` },
    ],
  },
];
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="landing-container">
        <div className="footer-grid">
          <div>
            <Link href="/" className="brand">
              <Image src="/optio-mark.svg" alt="" width={30} height={30} />
              optio
            </Link>
            <p>
              One workspace for your agents.
              <br />
              Built to run on your terms.
            </p>
          </div>
          {groups.map((group) => (
            <div key={group.title}>
              <h2>{group.title}</h2>
              <ul>
                {group.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Optio</span>
          <span>Self-hosted. Open source. Yours.</span>
          <a href={github}>
            Built in the open <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </footer>
  );
}
