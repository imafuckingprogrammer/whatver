import { Router, type Request, type Response } from "express";

const router = Router();

interface ChatBody {
  siteKey: string;
  visitorId: string;
  message: string;
}

router.post("/", (req: Request, res: Response) => {
  const { siteKey, visitorId, message } = req.body as Partial<ChatBody>;

  if (!siteKey || !visitorId || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "siteKey, visitorId, and message are required" });
    return;
  }

  // Placeholder — real agent logic will replace this
  const reply = `I received: ${message.trim()}`;

  res.json({ reply });
});

export default router;
