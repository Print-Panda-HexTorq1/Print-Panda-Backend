import crypto from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { requireAdmin, signToken } from "./auth.js";
import { getAnalytics } from "./queueService.js";
import { nowIso } from "./utils.js";

const adminRouter = express.Router();

function generateUid() {
  return crypto.randomBytes(5).toString("hex"); // 10-char hex uid
}

function generateUserUid() {
  return `u_${crypto.randomBytes(6).toString("hex")}`;
}

function serializeClient(client) {
  if (!client) return client;
  const { pay_panda_app_secret: _secret, ...safeClient } = client;
  return {
    ...safeClient,
    has_pay_panda_secret: Boolean(String(client.pay_panda_app_secret || "").trim())
  };
}

async function ensureUserUid(db, userRow) {
  if (!userRow) return null;
  const existing = String(userRow.user_uid || "").trim();
  if (existing) return userRow;

  let userUid = generateUserUid();
  let uidExists = await db.get("SELECT id FROM users WHERE user_uid = ?", [userUid]);
  while (uidExists) {
    userUid = generateUserUid();
    uidExists = await db.get("SELECT id FROM users WHERE user_uid = ?", [userUid]);
  }

  await db.run("UPDATE users SET user_uid = ? WHERE id = ?", [userUid, userRow.id]);
  return { ...userRow, user_uid: userUid };
}

// POST /api/admin/login
adminRouter.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (
    typeof username !== "string" ||
    typeof password !== "string" ||
    username.trim() !== config.adminUsername ||
    password !== config.adminPassword
  ) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = signToken({ role: "admin", username: config.adminUsername });
  return res.json({ token });
});

// All routes below require admin JWT
adminRouter.use(requireAdmin);

// GET /api/admin/clients
adminRouter.get("/clients", async (_, res, next) => {
  try {
    const db = getDb();
    const clients = await db.all("SELECT * FROM clients ORDER BY created_at DESC");
    return res.json(clients.map(serializeClient));
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/analytics?clientId=123&userId=456&range=7d&date=2026-07-19
adminRouter.get("/analytics", async (req, res, next) => {
  try {
    const raw = req.query?.clientId;
    const clientId = raw ? Number(raw) : null;
    const rawUser = req.query?.userId;
    const userId = rawUser ? Number(rawUser) : null;
    const date = String(req.query?.date || "").trim();
    const rawRange = String(req.query?.range || "all").toLowerCase();
    const range = ["today", "7d", "30d", "all"].includes(rawRange) ? rawRange : "all";
    const data = await getAnalytics(
      Number.isFinite(clientId) && clientId > 0 ? clientId : null,
      range,
      {
        userId: Number.isFinite(userId) && userId > 0 ? userId : null,
        date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ""
      }
    );
    return res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/clients
adminRouter.post("/clients", async (req, res, next) => {
  try {
    const {
      shopName,
      upiId = "",
      upiName = "",
      bwPrice = config.defaultBwPrice,
      colorPrice = config.defaultColorPrice,
      payPandaAppId = "",
      payPandaAppSecret = "",
      payPandaApiBase = ""
    } = req.body || {};
    if (!shopName || typeof shopName !== "string" || !shopName.trim()) {
      return res.status(400).json({ error: "shopName is required" });
    }
    const safeBwPrice = Number.isFinite(Number(bwPrice)) && Number(bwPrice) >= 0
      ? Number(bwPrice)
      : Number(config.defaultBwPrice || 3);
    const safeColorPrice = Number.isFinite(Number(colorPrice)) && Number(colorPrice) >= 0
      ? Number(colorPrice)
      : Number(config.defaultColorPrice || 10);
    const db = getDb();
    const uid = generateUid();
    const now = nowIso();
    const result = await db.run(
      `INSERT INTO clients (
         client_uid, shop_name, upi_id, upi_name, bw_price, color_price,
         pay_panda_app_id, pay_panda_app_secret, pay_panda_api_base, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid,
        shopName.trim(),
        upiId.trim(),
        upiName.trim(),
        safeBwPrice,
        safeColorPrice,
        String(payPandaAppId || "").trim(),
        String(payPandaAppSecret || "").trim(),
        String(payPandaApiBase || "").trim(),
        now
      ]
    );
    const client = await db.get("SELECT * FROM clients WHERE id = ?", [result.lastID]);
    return res.status(201).json(serializeClient(client));
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/clients/:id
adminRouter.put("/clients/:id", async (req, res, next) => {
  try {
    const db = getDb();
    const client = await db.get("SELECT * FROM clients WHERE id = ?", [req.params.id]);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const shopName = typeof req.body.shopName === "string" ? req.body.shopName.trim() : client.shop_name;
    const upiId = typeof req.body.upiId === "string" ? req.body.upiId.trim() : client.upi_id;
    const upiName = typeof req.body.upiName === "string" ? req.body.upiName.trim() : client.upi_name;
    const payPandaAppId = typeof req.body.payPandaAppId === "string" ? req.body.payPandaAppId.trim() : client.pay_panda_app_id;
    const payPandaAppSecret = typeof req.body.payPandaAppSecret === "string" && req.body.payPandaAppSecret.trim()
      ? req.body.payPandaAppSecret.trim()
      : client.pay_panda_app_secret;
    const payPandaApiBase = typeof req.body.payPandaApiBase === "string" ? req.body.payPandaApiBase.trim() : client.pay_panda_api_base;
    const bwPrice = Number.isFinite(Number(req.body.bwPrice)) && Number(req.body.bwPrice) >= 0
      ? Number(req.body.bwPrice)
      : Number(client.bw_price || config.defaultBwPrice || 3);
    const colorPrice = Number.isFinite(Number(req.body.colorPrice)) && Number(req.body.colorPrice) >= 0
      ? Number(req.body.colorPrice)
      : Number(client.color_price || config.defaultColorPrice || 10);

    if (!shopName) return res.status(400).json({ error: "shopName cannot be empty" });

    await db.run(
      `UPDATE clients
       SET shop_name = ?, upi_id = ?, upi_name = ?, bw_price = ?, color_price = ?,
           pay_panda_app_id = ?, pay_panda_app_secret = ?, pay_panda_api_base = ?
       WHERE id = ?`,
      [shopName, upiId, upiName, bwPrice, colorPrice, payPandaAppId, payPandaAppSecret, payPandaApiBase, client.id]
    );
    const updated = await db.get("SELECT * FROM clients WHERE id = ?", [client.id]);
    return res.json(serializeClient(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/clients/:id
adminRouter.delete("/clients/:id", async (req, res, next) => {
  try {
    const db = getDb();
    const client = await db.get("SELECT * FROM clients WHERE id = ?", [req.params.id]);
    if (!client) return res.status(404).json({ error: "Client not found" });
    await db.run("DELETE FROM clients WHERE id = ?", [client.id]);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/clients/:id/users
adminRouter.get("/clients/:id/users", async (req, res, next) => {
  try {
    const db = getDb();
    const users = await db.all(
      "SELECT id, client_id, user_uid, username, created_at FROM users WHERE client_id = ? ORDER BY created_at DESC",
      [req.params.id]
    );
    const withUids = [];
    for (const user of users) {
      withUids.push(await ensureUserUid(db, user));
    }
    return res.json(withUids);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/clients/:id/users
adminRouter.post("/clients/:id/users", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || typeof username !== "string" || !username.trim()) {
      return res.status(400).json({ error: "username is required" });
    }
    if (!password || typeof password !== "string" || password.length < 4) {
      return res.status(400).json({ error: "password must be at least 4 characters" });
    }
    const db = getDb();
    const client = await db.get("SELECT * FROM clients WHERE id = ?", [req.params.id]);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const existing = await db.get("SELECT id FROM users WHERE username = ?", [username.trim()]);
    if (existing) return res.status(409).json({ error: "Username already exists" });

    let userUid = generateUserUid();
    let uidExists = await db.get("SELECT id FROM users WHERE user_uid = ?", [userUid]);
    while (uidExists) {
      userUid = generateUserUid();
      uidExists = await db.get("SELECT id FROM users WHERE user_uid = ?", [userUid]);
    }

    const hash = await bcrypt.hash(password, 10);
    const now = nowIso();
    const result = await db.run(
      "INSERT INTO users (client_id, user_uid, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      [client.id, userUid, username.trim(), hash, now]
    );
    const user = await db.get(
      "SELECT id, client_id, user_uid, username, created_at FROM users WHERE id = ?",
      [result.lastID]
    );
    return res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/users/:userId
adminRouter.delete("/users/:userId", async (req, res, next) => {
  try {
    const db = getDb();
    const user = await db.get("SELECT id FROM users WHERE id = ?", [req.params.userId]);
    if (!user) return res.status(404).json({ error: "User not found" });
    await db.run("DELETE FROM users WHERE id = ?", [user.id]);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:userId/password
adminRouter.patch("/users/:userId/password", async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password || typeof password !== "string" || password.length < 4) {
      return res.status(400).json({ error: "password must be at least 4 characters" });
    }
    const db = getDb();
    const user = await db.get("SELECT id FROM users WHERE id = ?", [req.params.userId]);
    if (!user) return res.status(404).json({ error: "User not found" });
    const hash = await bcrypt.hash(password, 10);
    await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, user.id]);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export { adminRouter };
