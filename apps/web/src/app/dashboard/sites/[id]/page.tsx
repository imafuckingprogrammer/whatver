import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { CopyButton } from "@/app/dashboard/copy-button";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";

type Props = { params: Promise<{ id: string }> };

export default async function SiteDetailPage({ params }: Props) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: site } = await supabase
    .from("sites")
    .select("id, name, domain, site_key, config, created_at")
    .eq("id", id)
    .single();

  if (!site) notFound();

  const tag = `<script src="${SERVER_URL}/embed/${site.site_key}.js"></script>`;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center gap-3">
          <Link
            href="/dashboard"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm text-muted-foreground">/</span>
          <span className="text-sm font-medium">{site.name}</span>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto px-6 py-12 w-full space-y-10">
        {/* Overview */}
        <section className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{site.name}</h1>
          <p className="text-sm text-muted-foreground">{site.domain}</p>
        </section>

        {/* Install */}
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">Install</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Paste this script tag before the closing{" "}
              <code className="font-mono">&lt;/body&gt;</code> on your site.
            </p>
          </div>

          <div className="flex items-center gap-2 border border-border rounded-lg px-4 py-3">
            <code className="text-sm font-mono text-muted-foreground flex-1 break-all">
              {tag}
            </code>
            <CopyButton text={tag} />
          </div>
        </section>

        {/* Metadata */}
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Details</h2>
          <dl className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {[
              { label: "Site ID", value: site.id },
              { label: "Site key", value: site.site_key },
              { label: "Domain", value: site.domain },
              {
                label: "Created",
                value: new Date(site.created_at).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                }),
              },
            ].map(({ label, value }) => (
              <div key={label} className="flex px-4 py-3 gap-4">
                <dt className="text-xs text-muted-foreground w-24 shrink-0 pt-px">
                  {label}
                </dt>
                <dd className="text-xs font-mono text-foreground break-all">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </main>
    </div>
  );
}
