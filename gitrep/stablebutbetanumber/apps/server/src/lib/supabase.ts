import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
// Service role key bypasses RLS — server enforces its own authorization.
// Falls back to anon key so local dev works without the service key.
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, key, {
  auth: { persistSession: false },
});
