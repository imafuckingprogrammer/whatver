import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <header className="border-b border-border">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="text-sm font-medium">Agent</span>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/signup">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24">
        <div className="max-w-2xl space-y-6">
          <div className="inline-flex items-center gap-2 border border-border rounded-full px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
            Open beta
          </div>

          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-tight">
            Your website now has
            <br />
            an AI employee
          </h1>

          <p className="text-lg text-muted-foreground max-w-lg mx-auto">
            Paste one script tag. The agent reads your page, clicks buttons,
            fills forms, and helps visitors get things done — on any site.
          </p>

          <div className="flex items-center justify-center gap-3 pt-2">
            <Button size="lg" asChild>
              <Link href="/signup">Start for free</Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </div>

        {/* Feature grid */}
        <div className="mt-24 grid sm:grid-cols-3 gap-6 max-w-3xl w-full text-left">
          {[
            {
              title: "One script tag",
              body: "Drop a single line of HTML into your site. No SDK, no framework lock-in, no config.",
            },
            {
              title: "Full page control",
              body: "The agent sees your live DOM, clicks elements, fills inputs, and scrolls — in real time.",
            },
            {
              title: "Gets smarter over time",
              body: "Completed tasks are saved as memory. Repeat visitors get faster, more accurate help.",
            },
          ].map(({ title, body }) => (
            <div
              key={title}
              className="border border-border rounded-lg p-5 space-y-2"
            >
              <p className="text-sm font-medium">{title}</p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {body}
              </p>
            </div>
          ))}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="max-w-5xl mx-auto px-6 h-12 flex items-center">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} Agent
          </p>
        </div>
      </footer>
    </div>
  );
}
