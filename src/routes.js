import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import { PayPanda } from "pay-panda-js";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { detectPageCount } from "./documentInspector.js";
import { calculateTotalPrice, countSelectedPages } from "./pricing.js";
import {
  addJobStatusHistory,
  cancelJobAndDeleteFile,
  getJobById,
  getAnalytics,
  listJobStatusHistory,
  listQueues,
  markDownloaded,
  scheduleCleanupForJob,
  updateJobPrintProgress,
  updateStatus
} from "./queueService.js";
import { formatQueueToken, getIsoDatePart, nowIso, safeInt, toBooleanInt } from "./utils.js";
import { requireUser, signToken, verifyToken } from "./auth.js";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, config.uploadsDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});

const upload = multer({ storage });
let payPandaClient = null;

function upiLink(jobId, amount, upiId, upiName) {
  const params = new URLSearchParams({
    pa: upiId || config.upiId,
    pn: upiName || config.upiName,
    am: String(amount),
    cu: "INR",
    tn: `Print Job ${jobId}`
  });
  return `upi://pay?${params.toString()}`;
}

function isPayPandaConfigured() {
  return Boolean(config.payPandaAppId && config.payPandaAppSecret);
}

function getPayPandaClient() {
  if (!isPayPandaConfigured()) {
    return null;
  }
  if (!payPandaClient) {
    payPandaClient = new PayPanda({
      appId: config.payPandaAppId,
      appSecret: config.payPandaAppSecret,
      apiBase: config.payPandaApiBase
    });
  }
  return payPandaClient;
}

function makePayPandaOrderId(jobId) {
  return `PP-JOB-${jobId}`;
}

function getPayPandaRedirectUrl() {
  return config.payPandaRedirectUrl || `${config.publicBaseUrl}/api/pay-panda/callback`;
}

function normalizePayPandaStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function isSuccessfulPayPandaStatus(value) {
  return ["SUCCESS", "PAID", "COMPLETED", "CAPTURED"].includes(normalizePayPandaStatus(value));
}

function getVerificationPaymentId(verification = {}) {
  return verification.paymentId || verification.payment_id || verification.pay_panda_payment_id || "";
}

function getVerificationBankRrn(verification = {}) {
  return verification.bankRrn || verification.bank_rrn || verification.rrn || "";
}

async function attachPaymentToJob({ job, amount, customerName, customerMobile, fallbackUpiId, fallbackUpiName }) {
  const db = getDb();
  const orderId = makePayPandaOrderId(job.id);
  const fallbackPayment = {
    provider: "upi",
    amount,
    upiId: fallbackUpiId || config.upiId,
    upiLink: upiLink(job.id, amount, fallbackUpiId, fallbackUpiName),
    autoPaymentEnabled: Boolean(Number(job.auto_payment_enabled ?? 1)),
    autoVerificationAvailable: false
  };

  const payPanda = getPayPandaClient();
  if (!payPanda) {
    await db.run(
      "UPDATE jobs SET payment_provider = 'upi', payment_order_id = ?, updated_at = ? WHERE id = ?",
      [orderId, nowIso(), job.id]
    );
    return fallbackPayment;
  }

  try {
    const payment = await payPanda.createPayment({
      orderId,
      amount,
      customerName: customerName || "Guest",
      customerMobile,
      reason: `Print Panda job ${job.queue_token || job.id}`,
      remark1: `Job #${job.id}`,
      redirectUrl: getPayPandaRedirectUrl(),
      expiresInMinutes: 20
    });
    await db.run(
      `UPDATE jobs
       SET payment_provider = 'pay_panda',
           payment_order_id = ?,
           pay_panda_payment_id = ?,
           pay_panda_checkout_url = ?,
           pay_panda_status = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        orderId,
        payment.paymentId || "",
        payment.checkoutUrl || "",
        payment.status || "PENDING",
        nowIso(),
        job.id
      ]
    );
    return {
      ...fallbackPayment,
      provider: "pay_panda",
      orderId,
      paymentId: payment.paymentId,
      checkoutUrl: payment.checkoutUrl,
      upiLink: payment.checkoutUrl || fallbackPayment.upiLink,
      autoVerificationAvailable: true,
      status: payment.status || "PENDING"
    };
  } catch (error) {
    console.error("Pay-Panda checkout creation failed; falling back to UPI", error);
    await db.run(
      "UPDATE jobs SET payment_provider = 'upi', payment_order_id = ?, updated_at = ? WHERE id = ?",
      [orderId, nowIso(), job.id]
    );
    return fallbackPayment;
  }
}

async function verifyPayPandaJob(job, input = {}) {
  const payPanda = getPayPandaClient();
  if (!payPanda) {
    throw new Error("Pay-Panda is not configured on this backend");
  }

  const orderId = input.orderId || job.payment_order_id || makePayPandaOrderId(job.id);
  const paymentId = input.paymentId || job.pay_panda_payment_id || "";
  const verification = await payPanda.verifyPayment({
    paymentId,
    orderId,
    amount: Number(job.total_price || 0),
    customerMobile: input.customerMobile || ""
  });
  const status = normalizePayPandaStatus(verification?.status || input.status);
  if (!isSuccessfulPayPandaStatus(status)) {
    const error = new Error("Payment is not successful yet");
    error.statusCode = 409;
    throw error;
  }
  return {
    ...verification,
    paymentId: getVerificationPaymentId(verification) || paymentId,
    status,
    bankRrn: getVerificationBankRrn(verification)
  };
}

async function markPaymentVerified(job, verification = {}, actor = null) {
  const db = getDb();
  const verifiedAt = nowIso();
  const verificationMode = verification.mode || (Number(job.auto_payment_enabled ?? 1) ? "auto" : "manual");
  const verifiedBy = actor?.username || verification.verifiedBy || (verificationMode === "auto" ? "Pay-Panda" : "Manual");
  await db.run(
    `UPDATE jobs
     SET pay_panda_payment_id = COALESCE(?, pay_panda_payment_id),
         pay_panda_status = COALESCE(?, pay_panda_status),
         pay_panda_bank_rrn = COALESCE(?, pay_panda_bank_rrn),
         payment_verified_at = ?,
         payment_verification_mode = ?,
         payment_verified_by_username = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      verification.paymentId || null,
      verification.status || null,
      verification.bankRrn || null,
      verifiedAt,
      verificationMode,
      verifiedBy,
      verifiedAt,
      job.id
    ]
  );

  let current = await getJobById(job.id);
  if (current.status === "payment_pending") {
    current = await updateStatus(job.id, "paid", actor);
  }
  if (Number(current.auto_payment_enabled ?? 1) && current.status === "paid") {
    current = await updateStatus(job.id, "approved", actor);
  }
  return current;
}

async function markManualPaymentReceived(job, actor = null) {
  const db = getDb();
  const verifiedAt = nowIso();
  await db.run(
    `UPDATE jobs
     SET payment_verified_at = COALESCE(payment_verified_at, ?),
         payment_verification_mode = COALESCE(payment_verification_mode, 'manual'),
         payment_verified_by_username = COALESCE(NULLIF(payment_verified_by_username, ''), ?),
         updated_at = ?
     WHERE id = ?`,
    [
      verifiedAt,
      actor?.username || "Manual",
      verifiedAt,
      job.id
    ]
  );
  const current = await getJobById(job.id);
  if (current.status === "payment_pending") {
    return updateStatus(job.id, "paid", actor);
  }
  return current;
}

export function createRoutes({ onQueueChanged }) {
  function generateUserUid() {
    return `u_${crypto.randomBytes(6).toString("hex")}`;
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

  async function createQueueToken(db, createdAt, jobId) {
    const datePart = getIsoDatePart(createdAt);
    const row = await db.get(
      `SELECT COUNT(*) AS sequence
       FROM jobs
       WHERE substr(created_at, 1, 10) = ?
         AND (created_at < ? OR (created_at = ? AND id <= ?))`,
      [datePart, createdAt, createdAt, jobId]
    );
    return formatQueueToken(row?.sequence || 1);
  }

  async function pickAssignedUserId(db, clientId, seedJobId) {
    const users = await db.all("SELECT id FROM users WHERE client_id = ? ORDER BY id ASC", [clientId]);
    if (!users.length) return null;
    const index = Math.abs(Number(seedJobId) || 0) % users.length;
    return users[index].id;
  }

  async function resolveActorFromHeader(req) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return null;
    try {
      const payload = verifyToken(token);
      if (payload.role !== "user" || !payload.userId || !payload.clientId) {
        return null;
      }
      const db = getDb();
      const row = await db.get(
        `SELECT u.id AS user_id, u.username, c.id AS client_id, c.client_uid, c.shop_name
         FROM users u
         JOIN clients c ON c.id = u.client_id
         WHERE u.id = ? AND c.id = ?`,
        [payload.userId, payload.clientId]
      );
      if (!row) return null;
      return {
        userId: row.user_id,
        username: row.username,
        clientId: row.client_id,
        clientUid: row.client_uid,
        shopName: row.shop_name
      };
    } catch {
      return null;
    }
  }

  function ensureOperatorOwnsJob(job, reqUser) {
    if (!job || !reqUser) {
      return false;
    }
    return Number(job.client_id) === Number(reqUser.clientId)
      && Number(job.assigned_user_id) === Number(reqUser.userId);
  }

  function getStageFromStatus(status) {
    const value = String(status || "").toLowerCase();
    switch (value) {
      case "payment_pending":
        return { key: "not_paid", label: "Not Paid", queueLabel: "Not Paid" };
      case "paid":
        return { key: "payment_verify", label: "Payment Verify Queue", queueLabel: "Payment Verify Queue" };
      case "approved":
        return { key: "ready_for_print", label: "Ready for Print", queueLabel: "Ready for Print" };
      case "printing":
        return { key: "printing", label: "Printing Queue", queueLabel: "Printing Queue" };
      case "printed":
        return { key: "printed", label: "Printed Queue", queueLabel: "Printed Queue" };
      case "print_failed":
        return { key: "failed", label: "Failed Queue", queueLabel: "Failed Queue" };
      case "rejected":
        return { key: "rejected", label: "Rejected", queueLabel: "Rejected" };
      default:
        return { key: "unknown", label: "Unknown", queueLabel: "Unknown" };
    }
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  router.get("/health", (_, res) => {
    res.json({ ok: true, name: "panda-print-backend" });
  });

  // ── Desktop-user auth ──────────────────────────────────────────────────────
  router.post("/api/auth/login", async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: "username and password required" });
      }
      const db = getDb();
      const user = await db.get("SELECT * FROM users WHERE username = ?", [String(username).trim()]);
      if (!user) return res.status(401).json({ error: "Invalid credentials" });
      const safeUser = await ensureUserUid(db, user);

      const match = await bcrypt.compare(String(password), safeUser.password_hash);
      if (!match) return res.status(401).json({ error: "Invalid credentials" });

      const client = await db.get("SELECT * FROM clients WHERE id = ?", [safeUser.client_id]);
      if (!client) return res.status(401).json({ error: "Client not found" });

      const token = signToken({ role: "user", userId: safeUser.id, clientId: client.id, clientUid: client.client_uid });
      return res.json({ token, user: { id: safeUser.id, user_uid: safeUser.user_uid, username: safeUser.username }, client });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/auth/me", requireUser, async (req, res, next) => {
    try {
      const db = getDb();
      const user = await db.get("SELECT id, user_uid, username, client_id, created_at FROM users WHERE id = ?", [req.user.userId]);
      const safeUser = await ensureUserUid(db, user);
      if (!safeUser) return res.status(404).json({ error: "User not found" });
      const client = await db.get("SELECT * FROM clients WHERE id = ?", [safeUser.client_id]);
      return res.json({ user: safeUser, client });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/shop/settings", requireUser, async (req, res, next) => {
    try {
      const db = getDb();
      const client = await db.get(
        "SELECT id, auto_payment_enabled, bw_price, color_price FROM clients WHERE id = ?",
        [req.user.clientId]
      );
      if (!client) {
        return res.status(404).json({ error: "Shop not found" });
      }
      res.json({
        autoPaymentEnabled: Boolean(Number(client.auto_payment_enabled ?? 1)),
        bwPrice: Number.isFinite(Number(client.bw_price)) ? Number(client.bw_price) : Number(config.defaultBwPrice),
        colorPrice: Number.isFinite(Number(client.color_price)) ? Number(client.color_price) : Number(config.defaultColorPrice),
        payPandaConfigured: isPayPandaConfigured()
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/shop/settings", requireUser, async (req, res, next) => {
    try {
      const db = getDb();
      const client = await db.get(
        "SELECT id, auto_payment_enabled, bw_price, color_price FROM clients WHERE id = ?",
        [req.user.clientId]
      );
      if (!client) {
        return res.status(404).json({ error: "Shop not found" });
      }

      const nextAutoPayment = typeof req.body?.autoPaymentEnabled === "boolean"
        ? (req.body.autoPaymentEnabled ? 1 : 0)
        : Number(client.auto_payment_enabled ?? 1);
      const rawBwPrice = req.body?.bwPrice;
      const rawColorPrice = req.body?.colorPrice;
      const nextBwPrice = rawBwPrice === undefined
        ? Number(client.bw_price || config.defaultBwPrice)
        : Number(rawBwPrice);
      const nextColorPrice = rawColorPrice === undefined
        ? Number(client.color_price || config.defaultColorPrice)
        : Number(rawColorPrice);

      if (!Number.isFinite(nextBwPrice) || nextBwPrice < 0) {
        return res.status(400).json({ error: "Invalid B/W price" });
      }
      if (!Number.isFinite(nextColorPrice) || nextColorPrice < 0) {
        return res.status(400).json({ error: "Invalid color price" });
      }

      await db.run(
        "UPDATE clients SET auto_payment_enabled = ?, bw_price = ?, color_price = ? WHERE id = ?",
        [nextAutoPayment, Math.round(nextBwPrice), Math.round(nextColorPrice), req.user.clientId]
      );
      res.json({
        ok: true,
        autoPaymentEnabled: Boolean(nextAutoPayment),
        bwPrice: Math.round(nextBwPrice),
        colorPrice: Math.round(nextColorPrice),
        payPandaConfigured: isPayPandaConfigured()
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Queue – filtered by client when authenticated  ─────────────────────────
  router.get("/api/queues", requireUser, async (req, res, next) => {
    try {
      const data = await listQueues(req.user.clientId, req.user.userId);
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/analytics", requireUser, async (req, res, next) => {
    try {
      const rawRange = String(req.query?.range || "all").toLowerCase();
      const range = ["today", "7d", "30d", "all"].includes(rawRange) ? rawRange : "all";
      const data = await getAnalytics(req.user.clientId, range);
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/u/:userUid/details", async (req, res, next) => {
    try {
      const db = getDb();
      const user = await db.get(
        `SELECT
           u.id AS user_id,
           u.user_uid AS user_uid,
           u.username AS username,
           c.id AS client_id,
           c.client_uid AS client_uid,
           c.shop_name AS shop_name,
            c.upi_id AS upi_id,
            c.upi_name AS upi_name,
            c.bw_price AS bw_price,
            c.color_price AS color_price,
            c.auto_payment_enabled AS auto_payment_enabled
         FROM users u
         JOIN clients c ON c.id = u.client_id
         WHERE u.user_uid = ?`,
        [req.params.userUid]
      );

      if (!user) {
        return res.status(404).json({ error: "User upload link not found" });
      }

      return res.json({
        shopName: user.shop_name,
        assignedOperator: user.username,
        operatorUid: user.user_uid,
        clientUid: user.client_uid,
        upiId: user.upi_id || config.upiId,
        upiName: user.upi_name || config.upiName,
        autoPaymentEnabled: Boolean(Number(user.auto_payment_enabled ?? 1)),
        pricing: {
          bw: Number.isFinite(Number(user.bw_price)) ? Number(user.bw_price) : Number(config.defaultBwPrice),
          color: Number.isFinite(Number(user.color_price)) ? Number(user.color_price) : Number(config.defaultColorPrice)
        }
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Per-client customer upload (public) ────────────────────────────────────
  router.post("/api/u/:userUid/jobs/upload", upload.single("document"), async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Document is required" });
      }
      const db = getDb();
      const user = await db.get(
        `SELECT
           u.id AS user_id,
           u.username AS username,
           u.client_id AS user_client_id,
           c.id AS client_id,
           c.shop_name AS shop_name,
           c.client_uid AS client_uid,
            c.upi_id AS upi_id,
            c.upi_name AS upi_name,
            c.bw_price AS bw_price,
            c.color_price AS color_price,
            c.auto_payment_enabled AS auto_payment_enabled
         FROM users u
         JOIN clients c ON c.id = u.client_id
         WHERE u.user_uid = ?`,
        [req.params.userUid]
      );
      if (!user) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: "User upload link not found" });
      }
      const resolvedClientId = Number(user.client_id || user.user_client_id || 0);
      const resolvedUserId = Number(user.user_id || 0);
      if (!resolvedClientId || !resolvedUserId) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Invalid user/shop mapping for this upload link" });
      }
      const now = nowIso();
      const copies = safeInt(req.body.copies, 1);
      const pageCount = await detectPageCount(req.file.path);
      const colorMode = req.body.colorMode === "color" ? "color" : "bw";
      const pageSelection = req.body.pageSelection || "all";
      const effectivePageCount = countSelectedPages(pageSelection, pageCount);
      const clientBwPrice = Number(user.bw_price);
      const clientColorPrice = Number(user.color_price);
      const { unitPrice, totalPrice } = calculateTotalPrice({
        colorMode,
        copies,
        pageCount: effectivePageCount,
        bwPrice: Number.isFinite(clientBwPrice) ? clientBwPrice : config.defaultBwPrice,
        colorPrice: Number.isFinite(clientColorPrice) ? clientColorPrice : config.defaultColorPrice
      });

      const insertResult = await db.run(
        `INSERT INTO jobs (
          client_id, assigned_user_id, customer_name, original_name, stored_name, file_path,
          page_count, copies, color_mode, page_selection, orientation, paper_size, duplex,
          unit_price, total_price, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          resolvedClientId,
          resolvedUserId,
          req.body.customerName || "Guest",
          req.file.originalname,
          req.file.filename,
          req.file.path,
          pageCount,
          copies,
          colorMode,
          req.body.pageSelection || "all",
          req.body.orientation || "portrait",
          req.body.paperSize || "A4",
          toBooleanInt(req.body.duplex),
          unitPrice,
          totalPrice,
          "payment_pending",
          now,
          now
        ]
      );

      await db.run("UPDATE jobs SET queue_token = ? WHERE id = ?", [
        await createQueueToken(db, now, insertResult.lastID),
        insertResult.lastID
      ]);
      await addJobStatusHistory(insertResult.lastID, "payment_pending", "upload", now);

      const job = await getJobById(insertResult.lastID);
      const payment = await attachPaymentToJob({
        job,
        amount: totalPrice,
        customerName: req.body.customerName || "Guest",
        customerMobile: req.body.customerMobile || "",
        fallbackUpiId: user.upi_id,
        fallbackUpiName: user.upi_name
      });
      onQueueChanged();

      return res.status(201).json({
        job,
        shopName: user.shop_name,
        assignedOperator: user.username,
        payment
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Per-client customer upload (public; backward compatibility) ───────────
  router.post("/api/c/:clientUid/jobs/upload", upload.single("document"), async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Document is required" });
      }
      const db = getDb();
      const client = await db.get("SELECT * FROM clients WHERE client_uid = ?", [req.params.clientUid]);
      if (!client) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: "Shop not found" });
      }
      const now = nowIso();
      const copies = safeInt(req.body.copies, 1);
      const pageCount = await detectPageCount(req.file.path);
      const colorMode = req.body.colorMode === "color" ? "color" : "bw";
      const pageSelection = req.body.pageSelection || "all";
      const effectivePageCount = countSelectedPages(pageSelection, pageCount);
      const clientBwPrice = Number(client.bw_price);
      const clientColorPrice = Number(client.color_price);
      const { unitPrice, totalPrice } = calculateTotalPrice({
        colorMode,
        copies,
        pageCount: effectivePageCount,
        bwPrice: Number.isFinite(clientBwPrice) ? clientBwPrice : config.defaultBwPrice,
        colorPrice: Number.isFinite(clientColorPrice) ? clientColorPrice : config.defaultColorPrice
      });

      const insertResult = await db.run(
        `INSERT INTO jobs (
          client_id, customer_name, original_name, stored_name, file_path,
          page_count, copies, color_mode, page_selection, orientation, paper_size, duplex,
          unit_price, total_price, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          client.id,
          req.body.customerName || "Guest",
          req.file.originalname,
          req.file.filename,
          req.file.path,
          pageCount,
          copies,
          colorMode,
          req.body.pageSelection || "all",
          req.body.orientation || "portrait",
          req.body.paperSize || "A4",
          toBooleanInt(req.body.duplex),
          unitPrice,
          totalPrice,
          "payment_pending",
          now,
          now
        ]
      );

      const assignedUserId = await pickAssignedUserId(db, client.id, insertResult.lastID);
      if (assignedUserId) {
        await db.run("UPDATE jobs SET assigned_user_id = ? WHERE id = ?", [assignedUserId, insertResult.lastID]);
      }

      await db.run("UPDATE jobs SET queue_token = ? WHERE id = ?", [
        await createQueueToken(db, now, insertResult.lastID),
        insertResult.lastID
      ]);
      await addJobStatusHistory(insertResult.lastID, "payment_pending", "upload", now);

      const job = await getJobById(insertResult.lastID);
      const payment = await attachPaymentToJob({
        job,
        amount: totalPrice,
        customerName: req.body.customerName || "Guest",
        customerMobile: req.body.customerMobile || "",
        fallbackUpiId: client.upi_id,
        fallbackUpiName: client.upi_name
      });
      onQueueChanged();

      return res.status(201).json({
        job,
        shopName: client.shop_name,
        payment
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Legacy upload (kept for backward compat / single-client mode) ──────────
  router.post("/api/jobs/upload", upload.single("document"), async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Document is required" });
      }

      const db = getDb();
      const now = nowIso();
      const copies = safeInt(req.body.copies, 1);
      const pageCount = await detectPageCount(req.file.path);
      const colorMode = req.body.colorMode === "color" ? "color" : "bw";
      const pageSelection = req.body.pageSelection || "all";
      const effectivePageCount = countSelectedPages(pageSelection, pageCount);
      const { unitPrice, totalPrice } = calculateTotalPrice({
        colorMode,
        copies,
        pageCount: effectivePageCount,
        bwPrice: config.defaultBwPrice,
        colorPrice: config.defaultColorPrice
      });

      const insertResult = await db.run(
        `INSERT INTO jobs (
          customer_name, original_name, stored_name, file_path,
          page_count,
          copies, color_mode, page_selection, orientation, paper_size, duplex,
          unit_price, total_price, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.body.customerName || "Guest",
          req.file.originalname,
          req.file.filename,
          req.file.path,
          pageCount,
          copies,
          colorMode,
          req.body.pageSelection || "all",
          req.body.orientation || "portrait",
          req.body.paperSize || "A4",
          toBooleanInt(req.body.duplex),
          unitPrice,
          totalPrice,
          "payment_pending",
          now,
          now
        ]
      );

      await db.run("UPDATE jobs SET queue_token = ? WHERE id = ?", [
        await createQueueToken(db, now, insertResult.lastID),
        insertResult.lastID
      ]);
      await addJobStatusHistory(insertResult.lastID, "payment_pending", "upload", now);

      const job = await getJobById(insertResult.lastID);
      const payment = await attachPaymentToJob({
        job,
        amount: totalPrice,
        customerName: req.body.customerName || "Guest",
        customerMobile: req.body.customerMobile || "",
        fallbackUpiId: config.upiId,
        fallbackUpiName: config.upiName
      });
      onQueueChanged();

      return res.status(201).json({
        job,
        payment
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/pay-panda/callback", async (req, res, next) => {
    try {
      const db = getDb();
      const paymentId = String(req.query.pay_panda_payment_id || req.query.payment_id || "").trim();
      const orderId = String(req.query.order_id || "").trim();
      const redirectedStatus = String(req.query.status || "").trim();
      const job = await db.get(
        `SELECT j.*, c.auto_payment_enabled AS auto_payment_enabled, u.user_uid AS user_uid
         FROM jobs j
         LEFT JOIN clients c ON c.id = j.client_id
         LEFT JOIN users u ON u.id = j.assigned_user_id
         WHERE (? <> '' AND j.payment_order_id = ?)
            OR (? <> '' AND j.pay_panda_payment_id = ?)
         ORDER BY j.id DESC
         LIMIT 1`,
        [orderId, orderId, paymentId, paymentId]
      );
      if (!job) {
        const target = `${config.webBaseUrl}/?payment=missing`;
        return res.redirect(target);
      }

      const verification = await verifyPayPandaJob(job, {
        paymentId,
        orderId,
        status: redirectedStatus
      });
      const updated = await markPaymentVerified(job, verification, {
        username: "pay-panda",
        clientId: job.client_id
      });
      onQueueChanged();
      const targetPath = job.user_uid ? `/u/${encodeURIComponent(job.user_uid)}` : "/";
      const params = new URLSearchParams({
        payment: "success",
        jobId: String(updated.id),
        token: String(updated.queue_token || `PP-${updated.id}`)
      });
      return res.redirect(`${config.webBaseUrl}${targetPath}?${params.toString()}`);
    } catch (error) {
      console.error("Pay-Panda callback verification failed", error);
      const params = new URLSearchParams({
        payment: "failed",
        reason: String(error?.message || "verification_failed").slice(0, 120)
      });
      return res.redirect(`${config.webBaseUrl}/?${params.toString()}`);
    }
  });

  async function verifyPaymentForJob(job, actor = null, input = {}) {
    if (String(job.payment_provider || "upi") !== "pay_panda") {
      return markManualPaymentReceived(job, actor);
    }
    const verification = await verifyPayPandaJob(job, input);
    return markPaymentVerified(job, {
      ...verification,
      mode: Number(job.auto_payment_enabled ?? 1) ? "auto" : "manual"
    }, actor);
  }

  router.post("/api/jobs/:id/verify-payment", async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      const updated = await verifyPaymentForJob(job, null, req.body || {});
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/u/:userUid/jobs/:id/verify-payment", async (req, res, next) => {
    try {
      const db = getDb();
      const job = await db.get(
        `SELECT j.*, c.auto_payment_enabled AS auto_payment_enabled
         FROM jobs j
         LEFT JOIN clients c ON c.id = j.client_id
         JOIN users u ON u.id = j.assigned_user_id
         WHERE j.id = ? AND u.user_uid = ?`,
        [req.params.id, req.params.userUid]
      );
      if (!job) {
        return res.status(404).json({ error: "Job not found for this upload link" });
      }

      const updated = await verifyPaymentForJob(job, null, req.body || {});
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/jobs/:id/settings", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (["printing", "printed"].includes(job.status)) {
        return res.status(400).json({ error: "Printed or printing jobs cannot be edited" });
      }

      const copies = safeInt(req.body.copies ?? job.copies, job.copies);
      const colorMode = req.body.colorMode === "color" ? "color" : (req.body.colorMode === "bw" ? "bw" : job.color_mode);
      const pageSelection = (req.body.pageSelection || job.page_selection || "all").trim() || "all";
      const orientation = req.body.orientation ? (req.body.orientation === "landscape" ? "landscape" : "portrait") : job.orientation;
      const paperSize = req.body.paperSize || job.paper_size || "A4";
      const duplex = toBooleanInt(req.body.duplex ?? job.duplex);
      const db = getDb();
      const client = job.client_id
        ? await db.get("SELECT bw_price, color_price FROM clients WHERE id = ?", [job.client_id])
        : null;
      const { unitPrice, totalPrice } = calculateTotalPrice({
        colorMode,
        copies,
        pageCount: countSelectedPages(pageSelection, job.page_count),
        bwPrice: Number.isFinite(Number(client?.bw_price)) ? Number(client.bw_price) : config.defaultBwPrice,
        colorPrice: Number.isFinite(Number(client?.color_price)) ? Number(client.color_price) : config.defaultColorPrice
      });

      await db.run(
        `UPDATE jobs
         SET copies = ?, color_mode = ?, page_selection = ?, orientation = ?, paper_size = ?, duplex = ?,
             unit_price = ?, total_price = ?, updated_at = ?
         WHERE id = ?`,
        [
          copies,
          colorMode,
          pageSelection,
          orientation,
          paperSize,
          duplex,
          unitPrice,
          totalPrice,
          nowIso(),
          job.id
        ]
      );

      const updated = await getJobById(job.id);
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/jobs/:id/approve-payment", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const actor = await resolveActorFromHeader(req);
      if (!job.payment_verified_at) {
        await markManualPaymentReceived(job, actor);
      }
      const updated = await updateStatus(req.params.id, "approved", actor);
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/jobs/:id/start-print", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const actor = await resolveActorFromHeader(req);
      const updated = await updateStatus(req.params.id, "printing", actor);
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/jobs/:id/complete-print", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const actor = await resolveActorFromHeader(req);
      const updated = await updateStatus(req.params.id, "printed", actor);
      scheduleCleanupForJob(updated.id, onQueueChanged);
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/jobs/:id/print-failed", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const actor = await resolveActorFromHeader(req);
      const updated = await updateStatus(req.params.id, "print_failed", actor);
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/jobs/:id/requeue", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const actor = await resolveActorFromHeader(req);
      const updated = await updateStatus(req.params.id, "approved", actor);
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/jobs/:id/reject", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const updated = await updateStatus(req.params.id, "rejected");
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/jobs/:id/print-progress", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (Number(job.client_id) !== Number(req.user.clientId) || Number(job.assigned_user_id) !== Number(req.user.userId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const updated = await updateJobPrintProgress(
        req.params.id,
        req.body?.pagesPrinted,
        req.body?.totalPages
      );
      onQueueChanged();
      res.json({ ok: true, job: updated });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/u/:userUid/jobs/:jobId/progress", async (req, res, next) => {
    try {
      const db = getDb();
      const link = await db.get(
        `SELECT j.id
         FROM jobs j
         JOIN users u ON u.id = j.assigned_user_id
         WHERE j.id = ? AND u.user_uid = ?`,
        [req.params.jobId, req.params.userUid]
      );
      if (!link) {
        return res.status(404).json({ error: "Job not found for this upload link" });
      }

      const job = await getJobById(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      const history = await listJobStatusHistory(req.params.jobId);
      const safeHistory = history.length
        ? history
        : [{ status: job.status, source: "system", created_at: job.updated_at || job.created_at || nowIso() }];
      const stage = getStageFromStatus(job.status);
      const fallbackTotalPages = Math.max(
        1,
        countSelectedPages(job.page_selection, Number(job.page_count) || 1) * Math.max(1, Number(job.copies) || 1)
      );
      const totalPages = Number(job.print_progress_total) > 0 ? Number(job.print_progress_total) : fallbackTotalPages;
      const pagesPrinted = Math.max(0, Number(job.print_progress_pages) || 0);
      const percent = totalPages > 0
        ? Math.max(0, Math.min(100, Math.round((pagesPrinted / totalPages) * 100)))
        : 0;

      res.json({
        job,
        stage,
        timeline: safeHistory.map((row) => ({
          status: row.status,
          stage: getStageFromStatus(row.status),
          source: row.source,
          at: row.created_at
        })),
        printProgress: {
          pagesPrinted,
          totalPages,
          percent,
          updatedAt: job.print_progress_updated_at || null
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/jobs/:id", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const removed = await cancelJobAndDeleteFile(req.params.id);
      onQueueChanged();
      res.json({ ok: true, removed: { id: removed.id, queue_token: removed.queue_token } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/jobs/:id/file", requireUser, async (req, res, next) => {
    try {
      const job = await getJobById(req.params.id);
      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }
      if (!ensureOperatorOwnsJob(job, req.user)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      if (!fs.existsSync(job.file_path)) {
        return res.status(404).json({ error: "File no longer available" });
      }

      await markDownloaded(job.id);
      onQueueChanged();
      res.download(job.file_path, job.original_name);
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _, res, __) => {
    console.error(error);
    res.status(400).json({ error: error.message || "Unexpected error" });
  });

  return router;
}
