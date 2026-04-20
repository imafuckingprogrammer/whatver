import { Router, type Request, type Response } from "express";
import { supabase } from "../lib/supabase";
import { getNextAction, type AgentRequest, type AgentAction } from "../lib/agent";

const router = Router();

interface ChatRequest {
  siteKey: string;
  visitorId: string;
  conversationId?: string;
  goal: string;
  page: string;
  history: string[];
}

// Simple history endpoint
router.get("/history", async (req: Request, res: Response) => {
  const { siteKey, conversationId } = req.query;

  if (!siteKey || !conversationId) {
    res.status(400).json({ error: "Missing params" });
    return;
  }

  try {
    const { data: site } = await supabase
      .from("sites")
      .select("id")
      .eq("site_key", siteKey)
      .single();

    if (!site) {
      res.status(404).json({ error: "Site not found" });
      return;
    }

    const { data: messages } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    const formatted = (messages || [])
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));

    res.json({ messages: formatted });
  } catch (err) {
    console.error("[history]", err);
    res.status(500).json({ error: "Failed" });
  }
});

// Main chat endpoint - single turn
router.post("/", async (req: Request, res: Response) => {
  const { siteKey, visitorId, conversationId: inputCid, goal, page, history } = req.body as ChatRequest;

  if (!siteKey || !visitorId || !goal || !page) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  try {
    // Verify site
    const { data: site } = await supabase
      .from("sites")
      .select("id")
      .eq("site_key", siteKey)
      .single();

    if (!site) {
      res.status(404).json({ error: "Site not found" });
      return;
    }

    // Get or create conversation
    let conversationId = inputCid;
    if (!conversationId) {
      const { data: newConv } = await supabase
        .from("conversations")
        .insert({ site_id: site.id, visitor_id: visitorId, status: "active" })
        .select("id")
        .single();
      conversationId = newConv?.id;
    }

    // Get next action from agent
    const action = await getNextAction({
      goal,
      page,
      history: history || []
    });

    // Log the interaction (minimal)
    if (history.length === 0) {
      // First turn - log the goal
      await supabase.from("messages").insert({
        conversation_id: conversationId,
        role: "user",
        content: goal
      });
    }

    // Log agent action
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: JSON.stringify(action)
    });

    res.json({ conversationId, action });
  } catch (err) {
    console.error("[chat]", err);
    res.status(500).json({
      error: "Agent error",
      action: { a: "done", m: "Something went wrong. Please try again." }
    });
  }
});

export default router;
