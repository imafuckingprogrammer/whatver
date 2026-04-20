"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteSite } from "@/app/actions/sites";

export function DeleteSiteButton({ siteId, siteName }: { siteId: string; siteName: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setPending(true);
    setError(null);

    const result = await deleteSite(siteId);

    if (result.error) {
      setError(result.error);
      setPending(false);
    } else {
      router.push("/dashboard");
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Delete {siteName}?</span>
        <Button
          id="confirm-delete"
          variant="destructive"
          size="sm"
          onClick={handleDelete}
          disabled={pending}
        >
          {pending ? "Deleting..." : "Yes, delete"}
        </Button>
        <Button
          id="cancel-delete"
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Cancel
        </Button>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    );
  }

  return (
    <Button
      id="delete-site"
      variant="ghost"
      size="sm"
      onClick={() => setConfirming(true)}
      className="text-muted-foreground hover:text-destructive"
    >
      <Trash2 className="h-4 w-4 mr-1.5" />
      Delete site
    </Button>
  );
}
