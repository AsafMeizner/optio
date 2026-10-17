import { DocsPageNavigation } from "@/components/docs/page-navigation";
import { DocsSidebar } from "@/components/docs/sidebar";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "TechArticle",
  publisher: {
    "@type": "Organization",
    name: "Optio",
    url: "https://optio.host",
  },
  mainEntityOfPage: {
    "@type": "WebPage",
    "@id": "https://optio.host/docs",
  },
  about: {
    "@type": "SoftwareApplication",
    name: "Optio",
    applicationCategory: "DeveloperApplication",
  },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-layout">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <DocsSidebar />
      <article className="docs-content">
        <DocsPageNavigation position="top" />
        {children}
        <DocsPageNavigation position="bottom" />
      </article>
    </div>
  );
}
