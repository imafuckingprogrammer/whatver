"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { createSite } from "@/app/actions/sites";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "./copy-button";
import type { Site } from "./page";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";

function scriptTag(site_key: string) {
  return `<script src="${SERVER_URL}/embed/${site_key}.js"></script>`;
}

export function SitesSection({ sites }: { sites: Site[] }) {
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const result = await createSite(new FormData(e.currentTarget));

    setPending(false);

    if (result.error) {
      setError(result.error);
    } else {
      setShowForm(false);
      formRef.current?.reset();
    }
  }

  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Sites</h2>
        {!showForm && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowForm(true)}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            New site
          </Button>
        )}
      </div>

      {/* New site form */}
      {showForm && (
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="border border-border rounded-lg p-5 space-y-4"
        >
          <p className="text-sm font-medium">New site</p>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                name="name"
                placeholder="My App"
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="site-domain">Domain</Label>
              <Input
                id="site-domain"
                name="domain"
                placeholder="example.com"
                required
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Creating..." : "Create site"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowForm(false);
                setError(null);
                formRef.current?.reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Sites list */}
      {sites.length === 0 && !showForm ? (
        <p className="text-sm text-muted-foreground">
          No sites yet. Create one to get started.
        </p>
      ) : (
        <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
          {sites.map((site) => {
            const tag = scriptTag(site.site_key);
            return (
              <div
                key={site.id}
                className="flex items-start gap-4 px-5 py-4 hover:bg-muted/40 transition-colors"
              >
                {/* Site info */}
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/sites/${site.id}`}
                      className="text-sm font-medium hover:underline underline-offset-4 truncate"
                    >
                      {site.name}
                    </Link>
                    <span className="text-xs text-muted-foreground truncate">
                      {site.domain}
                    </span>
                  </div>

                  {/* Script tag */}
                  <div className="flex items-center gap-1 bg-muted/60 rounded-md px-3 py-1.5">
                    <code className="text-xs font-mono text-muted-foreground flex-1 truncate">
                      {tag}
                    </code>
                    <CopyButton text={tag} />
                  </div>
                </div>

                {/* Arrow to detail */}
                <Link
                  href={`/dashboard/sites/${site.id}`}
                  className="shrink-0 self-center text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={`Open ${site.name}`}
                >
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
