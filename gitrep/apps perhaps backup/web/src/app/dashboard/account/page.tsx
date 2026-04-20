import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "../sign-out-button";

export default async function AccountPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Get stats
  const { count: totalSites } = await supabase
    .from("sites")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  const { data: sites } = await supabase
    .from("sites")
    .select("id")
    .eq("user_id", user.id);

  const siteIds = sites?.map((s) => s.id) ?? [];

  let totalConversations = 0;
  if (siteIds.length > 0) {
    const { count } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .in("site_id", siteIds);
    totalConversations = count ?? 0;
  }

  const details = [
    { label: "Email", value: user.email ?? "—" },
    { label: "User ID", value: user.id },
    {
      label: "Joined",
      value: new Date(user.created_at).toLocaleDateString("en-US", {
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
          <span className="text-sm font-medium">Account</span>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto px-6 py-10 w-full">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your account settings
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="border border-border rounded-lg p-4">
            <p className="text-2xl font-semibold">{totalSites ?? 0}</p>
            <p className="text-sm text-muted-foreground">Sites</p>
          </div>
          <div className="border border-border rounded-lg p-4">
            <p className="text-2xl font-semibold">{totalConversations}</p>
            <p className="text-sm text-muted-foreground">Total conversations</p>
          </div>
        </div>

        {/* Account details */}
        <div className="border border-border rounded-lg divide-y divide-border mb-8">
          {details.map((d) => (
            <div key={d.label} className="flex items-center px-4 py-3">
              <span className="text-sm text-muted-foreground w-24">{d.label}</span>
              <span className="text-sm font-mono">{d.value}</span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="space-y-4">
          <div className="border border-border rounded-lg p-4">
            <h3 className="text-sm font-medium mb-2">Sign out</h3>
            <p className="text-sm text-muted-foreground mb-3">
              Sign out of your account on this device.
            </p>
            <SignOutButton />
          </div>
        </div>
      </main>
    </div>
  );
}
