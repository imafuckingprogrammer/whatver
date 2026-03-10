import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { SiteDetailTabs } from "./site-detail-tabs";

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
    .select("id, name, domain, site_key, created_at")
    .eq("id", id)
    .single();

  if (!site) notFound();

  // Stats
  const { count: totalConversations } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("site_id", site.id);

  const { data: actionRows } = await supabase
    .from("agent_actions")
    .select("steps")
    .eq("site_id", site.id)
    .eq("success", true);

  const totalActions = (actionRows ?? []).reduce(
    (sum: number, r: { steps: unknown }) =>
      sum + (Array.isArray(r.steps) ? r.steps.length : 0),
    0
  );

  // Recent conversations
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, visitor_id, created_at, updated_at")
    .eq("site_id", site.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const scriptTag = `<script src="${SERVER_URL}/embed/${site.site_key}.js"></script>`;

  const details = [
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
  ];

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

      <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">{site.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">{site.domain}</p>
        </div>

        <SiteDetailTabs
          scriptTag={scriptTag}
          totalConversations={totalConversations ?? 0}
          totalActions={totalActions}
          conversations={(conversations ?? []) as Array<{
            id: string;
            visitor_id: string;
            created_at: string;
            updated_at: string | null;
          }>}
          details={details}
        />
      </main>
    </div>
  );
}
