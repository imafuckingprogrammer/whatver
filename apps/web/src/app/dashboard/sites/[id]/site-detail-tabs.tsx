"use client";

import { useState } from "react";
import { CopyButton } from "@/app/dashboard/copy-button";

type Conversation = {
  id: string;
  visitor_id: string;
  created_at: string;
  updated_at: string | null;
};

type Props = {
  scriptTag: string;
  totalConversations: number;
  totalActions: number;
  conversations: Conversation[];
  details: Array<{ label: string; value: string }>;
};

const TABS = ["Overview", "Conversations"] as const;
type Tab = (typeof TABS)[number];

export function SiteDetailTabs({
  scriptTag,
  totalConversations,
  totalActions,
  conversations,
  details,
}: Props) {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div>
      {/* Tab bar */}
      <div className="flex border-b border-border mb-8">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "px-4 py-2.5 text-sm font-medium transition-colors relative",
              tab === t
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {t}
            {tab === t && (
              <span className="absolute bottom-0 left-0 right-0 h-px bg-foreground" />
            )}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === "Overview" && (
        <div className="space-y-8">
          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-border rounded-lg px-5 py-4">
              <p className="text-xs text-muted-foreground mb-1">Conversations</p>
              <p className="text-2xl font-semibold tabular-nums">
                {totalConversations}
              </p>
            </div>
            <div className="border border-border rounded-lg px-5 py-4">
              <p className="text-xs text-muted-foreground mb-1">Actions taken</p>
              <p className="text-2xl font-semibold tabular-nums">
                {totalActions}
              </p>
            </div>
          </div>

          {/* Install */}
          <div className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">Install</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Paste before the closing{" "}
                <code className="font-mono">&lt;/body&gt;</code> tag.
              </p>
            </div>
            <div className="flex items-center gap-2 border border-border rounded-lg px-4 py-3">
              <code className="text-sm font-mono text-muted-foreground flex-1 break-all">
                {scriptTag}
              </code>
              <CopyButton text={scriptTag} />
            </div>
          </div>

          {/* Details */}
          <div className="space-y-3">
            <h2 className="text-sm font-medium">Details</h2>
            <dl className="divide-y divide-border border border-border rounded-lg overflow-hidden">
              {details.map(({ label, value }) => (
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
          </div>
        </div>
      )}

      {/* Conversations */}
      {tab === "Conversations" && (
        <div>
          {conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conversations yet.</p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                      Visitor
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                      Started
                    </th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                      Last active
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {conversations.map((c) => (
                    <tr key={c.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {c.visitor_id}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(c.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {c.updated_at
                          ? new Date(c.updated_at).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
