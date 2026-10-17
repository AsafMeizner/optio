import { Screenshot } from "@/components/screenshot";
import Link from "next/link";
import { ProductTour } from "@/components/product-tour";
import { CodeBlock } from "@/components/docs/code-block";

const github = "https://github.com/jonwiggins/optio";
const runtimes = [
  "Claude Code",
  "OpenAI Codex",
  "GitHub Copilot",
  "Google Gemini",
  "Cursor",
  "OpenCode",
  "OpenClaw",
];
const useCases = [
  {
    number: "01",
    category: "DEVELOPMENT",
    title: "From issue to pull request.",
    body: "Give an agent a repository and a bounded change. It works in a git worktree, opens a PR, and can resume with review feedback while Optio follows CI and merge status.",
    href: "/docs/guides/creating-tasks",
    link: "Explore repo workflows",
    detail: "Issue → Worktree → Agent → PR → Review",
  },
  {
    number: "02",
    category: "AUTOMATION",
    title: "Make the routine run itself.",
    body: "Schedule dependency updates, prepare a daily briefing, or investigate an incident. Turn event payloads into prompt parameters and keep the logs and outcome of every run.",
    href: "/docs/guides/integrations",
    link: "Explore triggers & integrations",
    detail: "Schedule or event → Run → Result",
  },
  {
    number: "03",
    category: "COLLABORATION",
    title: "Keep a specialist on hand.",
    body: "Give persistent agents a name, instructions, and an inbox. They work in turns, wake on messages or triggers, and can coordinate with other agents in your workspace.",
    href: `${github}/blob/main/docs/persistent-agents.md`,
    link: "Explore persistent agents",
    detail: "Message → Agent turn → Reply → Wait",
  },
];
const questions = [
  {
    question: "What do I need to run Optio?",
    answer:
      "A Kubernetes cluster, PostgreSQL, and Redis run the control plane. The local setup script deploys these with Docker Desktop. Bring credentials for the agent runtime you want to use; Optio Local can also connect your own machines for execution.",
  },
  {
    question: "Can I use my existing agent and model?",
    answer:
      "Choose a runtime for each piece of work, with the models and authentication methods that runtime supports. On a paired machine, Optio Local uses the CLI configuration and login already installed there. You can also run a shell command without an LLM.",
  },
  {
    question: "Does every workflow need a repository?",
    answer:
      "No. Repository work can produce pull requests, while standalone work can query connected tools, generate reports, or run commands. Interactive sessions and persistent agents support other ways of working. The Work form offers the combinations that fit.",
  },
  {
    question: "How much control do I have over agents?",
    answer:
      "Choose the connections, tools, and skills available to pod work. Configure code review, draft PRs, and automatic resume limits. Per-work settings can tighten a repository’s PR policies. Use organization or private ownership and workspace roles to manage access.",
  },
  {
    question: "Is Optio free, and where does my data go?",
    answer:
      "Optio is open source under the MIT license. You operate its infrastructure and store its state. Your chosen agents still communicate with their model providers and connected services; those services and your infrastructure may have their own costs.",
  },
];

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Optio",
            applicationCategory: "DeveloperApplication",
            operatingSystem: "Web, iOS, Android; Kubernetes server",
            description:
              "Self-hosted orchestration for coding agents, automated workflows, and interactive sessions.",
            url: "https://optio.host",
            license: `${github}/blob/main/LICENSE`,
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          }),
        }}
      />
      <section className="landing-hero">
        <div className="landing-container">
          <div className="hero-intro">
            <div>
              <p className="eyebrow">
                <span className="status-light" /> Open-source agent orchestration
              </p>
              <h1>
                Your agents.
                <br />
                Your infrastructure.
                <br />
                <span>One workspace.</span>
              </h1>
            </div>
            <div className="hero-summary">
              <p>
                Turn a prompt into a pull request. Put a workflow on a schedule. Pick up a session
                from your phone.
              </p>
              <p className="hero-description">
                Optio runs coding agents and automations on your Kubernetes cluster or your own
                machines—with one place to follow the work.
              </p>
              <div className="landing-actions">
                <Link href="/docs/getting-started" className="landing-button primary">
                  Get started <span aria-hidden="true">↗</span>
                </Link>
                <a href={github} className="landing-button secondary">
                  View on GitHub <span aria-hidden="true">↗</span>
                </a>
              </div>
              <p className="hero-note">
                Self-hosted <span>·</span> MIT licensed <span>·</span> Web, iOS & Android
              </p>
            </div>
          </div>
          <figure className="hero-shot">
            <div className="shot-bar">
              <span>
                <span className="window-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>{" "}
                optio / overview
              </span>
              <span className="shot-label">Your workspace, at a glance</span>
            </div>
            <a
              href="/screenshots/showcase/web-overview.webp"
              target="_blank"
              rel="noreferrer"
              aria-label="View the Optio overview screenshot at full size"
            >
              <Screenshot
                file="web-overview"
                alt="Optio overview showing work that needs attention, active sessions, agent usage, and persistent agents"
                eager
              />
            </a>
            <figcaption>
              <span>See what’s running. Know what needs you.</span>
              <span>Real product · Example data</span>
            </figcaption>
          </figure>
          <div className="runtime-strip">
            <p>Your agent. Your choice.</p>
            <div>
              {runtimes.map((runtime) => (
                <span key={runtime}>{runtime}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="possibilities" className="landing-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Built around the work</p>
              <h2>
                From the first prompt
                <br />
                to the next step.
              </h2>
            </div>
            <p>
              Optio handles the environment, triggers, and follow-through around your agents. You
              decide what to delegate and when to step in.
            </p>
          </div>
          <div className="use-case-grid">
            {useCases.map((item) => (
              <article className="use-case" key={item.number}>
                <div className="case-top">
                  <span className="case-number">{item.number}</span>
                  <span className="case-trigger">{item.category}</span>
                </div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <div className="case-flow">{item.detail}</div>
                <Link href={item.href}>
                  {item.link} <span aria-hidden="true">↗</span>
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="product" className="landing-section product-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Inside Optio</p>
              <h2>
                A clear view of
                <br />
                work in motion.
              </h2>
            </div>
            <p>
              One feed for tasks, recurring workflows, sessions, and persistent agents. Open the
              conversation, follow a run, or return to the terminal.
            </p>
          </div>
          <ProductTour />
          <div className="section-bottom-link">
            <span>When. Where. Who. What. Then. Five answers define the work.</span>
            <Link href="/platform">
              See how Optio fits together <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </section>

      <section id="infrastructure" className="landing-section">
        <div className="landing-container infrastructure-layout">
          <div>
            <p className="eyebrow">Your environment, connected</p>
            <h2>
              Run it where
              <br />
              it makes sense.
            </h2>
            <p className="section-description">
              Keep repeatable work in your cluster. Pair your laptop for hands-on sessions. Bring
              the tools your agents need.
            </p>
            <Link className="text-link" href="/docs/architecture">
              Explore the architecture ↗
            </Link>
          </div>
          <div className="environment-options">
            <article>
              <span className="environment-icon" aria-hidden="true">
                ⌘
              </span>
              <div>
                <h3>In your Kubernetes cluster</h3>
                <p>
                  Repository work uses separate git worktrees in pooled pods. Standalone jobs and
                  persistent agents have their own execution pools. Deploy with Helm and connect
                  PostgreSQL and Redis.
                </p>
                <Link href="/docs/deployment">Deployment guide ↗</Link>
              </div>
            </article>
            <article>
              <span className="environment-icon" aria-hidden="true">
                &gt;_
              </span>
              <div>
                <h3>On your own machine</h3>
                <p>
                  Pair Optio Local, choose an allowed directory, and use your existing agent CLI and
                  login. Return to the same conversation or terminal from the browser or a native
                  app.
                </p>
                <Link href="/docs/sessions">Local work & sessions ↗</Link>
              </div>
            </article>
            <article>
              <span className="environment-icon" aria-hidden="true">
                ↔
              </span>
              <div>
                <h3>With the tools you already use</h3>
                <p>
                  Connections bring credentials, MCP tools, shell environment, and instructions
                  together. Assign access by repository and runtime, then customize it for each
                  piece of pod work.
                </p>
                <Link href="/docs/guides/connections">Connections & access ↗</Link>
              </div>
            </article>
          </div>
        </div>
        <div className="landing-container integrations-band">
          <div>
            <span className="eyebrow">Start with a signal</span>
            <p>Manual · Schedule · Webhook · Ticket</p>
          </div>
          <p>
            GitHub · GitLab · Slack · Linear · Jira · Pylon · PagerDuty · Sentry · Alertmanager ·
            Datadog
          </p>
          <Link href="/docs/guides/integrations" aria-label="Explore event integrations">
            Explore integrations ↗
          </Link>
        </div>
      </section>

      <section id="mobile" className="landing-section mobile-section">
        <div className="landing-container mobile-layout">
          <div className="mobile-copy">
            <p className="eyebrow">Web to pocket</p>
            <h2>
              Step away.
              <br />
              Stay in the loop.
            </h2>
            <p>
              Native iOS and Android apps keep the same workspace within reach. Check the queue,
              reply to an agent, open a terminal, or start new work.
            </p>
            <ul className="feature-list">
              <li>Conversations and terminals on your phone</li>
              <li>Widgets and notifications for work that needs you</li>
              <li>iOS Live Activities and Apple Watch Smart Stack</li>
            </ul>
            <div className="mobile-links">
              <a href={`${github}/tree/main/apps/ios`}>Build for iOS ↗</a>
              <a href={`${github}/tree/main/apps/android`}>Build for Android ↗</a>
            </div>
            <p className="sample-note">
              Native apps built from source. Screens show fictional example work.
            </p>
          </div>
          <div className="mobile-showcase">
            <figure>
              <div className="phone-frame">
                <Screenshot
                  file="ios-session"
                  alt="iOS agent conversation with a reply composer and terminal controls"
                />
              </div>
              <figcaption>iOS · Continue the conversation</figcaption>
            </figure>
            <figure>
              <div className="phone-frame android">
                <Screenshot
                  file="android-work"
                  alt="Android Work feed with agent and local sessions"
                />
              </div>
              <figcaption>Android · Follow the work</figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section id="gallery" className="landing-section">
        <div className="landing-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">A closer look</p>
              <h2>The details stay connected.</h2>
            </div>
            <p>
              From the event that started a run to the conversation that moves it forward. Open a
              screen to explore it at full size.
            </p>
          </div>
          <div className="capture-gallery">
            {[
              {
                file: "web-trigger",
                title: "Turn an incident into a workflow",
                description: "A PagerDuty trigger, instructions, and run history in one place.",
              },
              {
                file: "web-conversations",
                title: "Keep conversations side by side",
                description: "Follow Claude Code and Codex conversations side by side.",
              },
            ].map((item) => (
              <a
                key={item.file}
                href={`/screenshots/showcase/${item.file}.webp`}
                target="_blank"
                rel="noreferrer"
                className="capture"
              >
                <div>
                  <Screenshot file={item.file} alt={item.description} />
                </div>
                <h3>
                  {item.title} <span aria-hidden="true">↗</span>
                </h3>
                <p>{item.description}</p>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section faq-section">
        <div className="landing-container faq-layout">
          <div>
            <p className="eyebrow">Before you start</p>
            <h2>A few useful answers.</h2>
            <p className="section-description">Want the implementation details?</p>
            <Link className="text-link" href="/docs">
              Find them in the documentation ↗
            </Link>
          </div>
          <div className="faq-list">
            {questions.map((item) => (
              <details key={item.question}>
                <summary>
                  {item.question}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section id="start" className="landing-section start-section">
        <div className="landing-container start-layout">
          <div>
            <p className="eyebrow">Start with one piece of work</p>
            <h2>
              Your next workflow
              <br />
              starts here.
            </h2>
            <p>
              Deploy locally with Docker Desktop and Kubernetes, connect an agent, and give it
              something useful to do.
            </p>
            <div className="landing-actions">
              <Link href="/docs/getting-started" className="landing-button primary">
                Get started ↗
              </Link>
              <Link href="/docs/deployment" className="landing-button secondary">
                Production deployment ↗
              </Link>
            </div>
          </div>
          <div className="install-snippet">
            <CodeBlock title="Terminal · Local installation">{`git clone https://github.com/jonwiggins/optio.git\ncd optio\n./scripts/setup-local.sh`}</CodeBlock>
            <p>
              Requires Docker Desktop with Kubernetes, Node.js 22+, pnpm 10+, Helm 3+, and kubectl.
            </p>
            <Link href="/docs/installation">Full installation requirements ↗</Link>
          </div>
        </div>
      </section>
    </>
  );
}
