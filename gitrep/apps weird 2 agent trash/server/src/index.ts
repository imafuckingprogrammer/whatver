import "dotenv/config";
import express from "express";
import cors from "cors";
import embedRouter from "./routes/embed";
import chatRouter from "./routes/chat";
import { parseDOM } from "./lib/agent";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Debug endpoint: test DOM parser
app.post("/api/debug-parse", async (req, res) => {
  const { elements, url, title } = req.body;
  if (!elements || !Array.isArray(elements)) {
    res.status(400).json({ error: "elements array required" });
    return;
  }
  try {
    const parsed = await parseDOM(elements, { url, title });
    console.log("\n[debug] ═══════════════════════════════════════════════════════");
    console.log("[debug] RAW INPUT:", elements.length, "elements");
    console.log("[debug] PARSED OUTPUT:");
    console.log(JSON.stringify(parsed, null, 2));
    console.log("[debug] ═══════════════════════════════════════════════════════\n");
    res.json({ raw: elements, parsed });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.use("/embed", embedRouter);
app.use("/api/chat", chatRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
