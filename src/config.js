import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  port: Number(process.env.PORT || 8080),
  wsPort: Number(process.env.WS_PORT || 8081),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  uploadsDir: path.resolve(__dirname, "../storage/uploads"),
  dbPath: path.resolve(__dirname, "../storage/panda_print.db"),
  upiId: process.env.UPI_ID || "pandaprint@oksbi",
  upiName: process.env.UPI_NAME || "Print Panda",
  defaultBwPrice: Number(process.env.DEFAULT_BW_PRICE || 3),
  defaultColorPrice: Number(process.env.DEFAULT_COLOR_PRICE || 10),
  retentionMinutes: Number(process.env.RETENTION_MINUTES || 10),
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin@panda2026",
  jwtSecret: process.env.JWT_SECRET || "panda-print-default-secret-change-in-prod-2026"
};
