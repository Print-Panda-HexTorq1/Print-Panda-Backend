import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "https://git-pipeline.metatronhost.in/print-panda").replace(/\/+$/, "");
const payPandaRedirectUrl = String(process.env.PAY_PANDA_REDIRECT_URL || "").trim()
  || `${publicBaseUrl}/api/pay-panda/callback`;
const payPandaAppId = String(
  process.env.PAY_PANDA_APP_ID
  || process.env.PAYPANDA_APP_ID
  || process.env.PAY_PANDA_CLIENT_ID
  || process.env.PAYPANDA_CLIENT_ID
  || ""
).trim();
const payPandaAppSecret = String(
  process.env.PAY_PANDA_APP_SECRET
  || process.env.PAYPANDA_APP_SECRET
  || process.env.PAY_PANDA_CLIENT_SECRET
  || process.env.PAYPANDA_CLIENT_SECRET
  || ""
).trim();

export const config = {
  port: Number(process.env.PRINT_PANDA_PORT || process.env.HTTP_PORT || process.env.PORT || 17005),
  wsPort: Number(process.env.PRINT_PANDA_WS_PORT || process.env.WS_PORT || 17006),
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
  jwtSecret: process.env.JWT_SECRET || "panda-print-default-secret-change-in-prod-2026",
  publicBaseUrl,
  webBaseUrl: String(process.env.WEB_BASE_URL || "https://print-panda.me").replace(/\/+$/, ""),
  payPandaApiBase: String(process.env.PAY_PANDA_API_BASE || "https://git-pipeline.metatronhost.in/pay-panda/api").replace(/\/+$/, ""),
  payPandaAppId,
  payPandaAppSecret,
  payPandaRedirectUrl
};
