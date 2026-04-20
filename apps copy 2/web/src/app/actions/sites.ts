"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

function generateSiteKey(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

export async function createSite(
  formData: FormData
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Not authenticated" };

  const name = (formData.get("name") as string | null)?.trim();
  const domain = (formData.get("domain") as string | null)?.trim();

  if (!name || !domain) return { error: "Name and domain are required" };

  const site_key = generateSiteKey();

  const { error } = await supabase
    .from("sites")
    .insert({ user_id: user.id, name, domain, site_key });

  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  return {};
}

export async function deleteSite(siteId: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Not authenticated" };

  // Verify ownership
  const { data: site } = await supabase
    .from("sites")
    .select("id")
    .eq("id", siteId)
    .eq("user_id", user.id)
    .single();

  if (!site) return { error: "Site not found" };

  // Delete related data first (conversations, messages, agent_actions)
  await supabase.from("agent_actions").delete().eq("site_id", siteId);

  const { data: conversations } = await supabase
    .from("conversations")
    .select("id")
    .eq("site_id", siteId);

  if (conversations && conversations.length > 0) {
    const convIds = conversations.map((c) => c.id);
    await supabase.from("messages").delete().in("conversation_id", convIds);
    await supabase.from("conversations").delete().eq("site_id", siteId);
  }

  // Delete the site
  const { error } = await supabase.from("sites").delete().eq("id", siteId);

  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  return {};
}

export async function updateSite(
  siteId: string,
  data: { name?: string; domain?: string }
): Promise<{ error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: "Not authenticated" };

  const { error } = await supabase
    .from("sites")
    .update(data)
    .eq("id", siteId)
    .eq("user_id", user.id);

  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/sites/${siteId}`);
  return {};
}
