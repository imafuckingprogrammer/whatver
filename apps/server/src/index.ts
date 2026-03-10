import "dotenv/config";
import express from "express";
import cors from "cors";
import embedRouter from "./routes/embed";
import chatRouter from "./routes/chat";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/embed", embedRouter);
app.use("/api/chat", chatRouter);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
