import { Router, type Request, type Response } from "express";

const router = Router();

interface DOMEntry {
  tag: string;
  visible: boolean;
  position: "in-view" | "above-fold" | "below-fold";
  id?: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  type?: string;
  href?: string;
  name?: string;
  role?: string;
  classes?: string;
  value?: string;
  disabled?: boolean;
  expanded?: string;
  checked?: string;
}

interface ChatBody {
  siteKey: string;
  visitorId: string;
  message: string;
  dom?: DOMEntry[];
}

router.post("/", (req: Request, res: Response) => {
  const { siteKey, visitorId, message, dom } = req.body as Partial<ChatBody>;

  if (!siteKey || !visitorId || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "siteKey, visitorId, and message are required" });
    return;
  }

  // Log DOM snapshot size for visibility during development
  if (dom) {
    console.log(`[chat] site=${siteKey} visitor=${visitorId} dom_elements=${dom.length}`);
  }

  // Placeholder — real agent logic will replace this
  const reply = `I received: ${message.trim()}`;

  res.json({ reply });
});

export default router;
