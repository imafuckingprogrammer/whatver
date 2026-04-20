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
