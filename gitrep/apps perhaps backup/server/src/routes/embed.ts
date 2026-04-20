import { Router, type Request, type Response } from "express";
import { getWidgetScript } from "../widget";

const router = Router();

// Cache the script at startup — it's static content
const WIDGET_SCRIPT = getWidgetScript();

router.get("/:siteKey.js", (req: Request, res: Response) => {
  const siteKey = req.params["siteKey"] as string;

  // Basic validation — only alphanumeric + hyphens/underscores
  if (!/^[a-z0-9_-]+$/i.test(siteKey)) {
    res.status(400).send("// invalid site key");
    return;
  }

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(WIDGET_SCRIPT);
});

export default router;
