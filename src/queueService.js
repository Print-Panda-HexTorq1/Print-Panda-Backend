import fs from "node:fs";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { nowIso } from "./utils.js";
import { countSelectedPages } from "./pricing.js";

const cleanupTimers = new Map();

function isAllowedTransition(from, to) {
  const transitions = {
    payment_pending: ["paid"],
    paid: ["approved", "rejected"],
    approved: ["printing", "print_failed"],
    printing: ["printed", "print_failed"],
    print_failed: ["approved"],
    printed: ["approved"]
  };
  return (transitions[from] || []).includes(to);
}

export async function getJobById(jobId) {
  const db = getDb();
  return db.get(
    `SELECT j.*, c.client_uid AS client_uid, c.shop_name AS shop_name,
            c.auto_payment_enabled AS auto_payment_enabled,
            c.pay_panda_app_id AS pay_panda_app_id,
            c.pay_panda_app_secret AS pay_panda_app_secret,
            c.pay_panda_api_base AS pay_panda_api_base,
            u.user_uid AS user_uid
     FROM jobs j
     LEFT JOIN clients c ON c.id = j.client_id
     LEFT JOIN users u ON u.id = j.assigned_user_id
     WHERE j.id = ?`,
    [jobId]
  );
}

export async function updateStatus(jobId, nextStatus, actor = null) {
  const db = getDb();
  const job = await getJobById(jobId);
  if (!job) {
    throw new Error("Job not found");
  }
  if (!isAllowedTransition(job.status, nextStatus)) {
    throw new Error(`Invalid status transition: ${job.status} -> ${nextStatus}`);
  }

  const updatedAt = nowIso();
  const shouldCapturePrintActor = ["printing", "printed", "print_failed"].includes(nextStatus) && actor;

  if (shouldCapturePrintActor) {
    await db.run(
      `UPDATE jobs
       SET status = ?,
           updated_at = ?,
           printed_by_user_id = ?,
           printed_by_username = ?,
           printed_by_client_uid = ?,
           printed_by_shop_name = ?,
           printed_at = CASE WHEN ? = 'printed' THEN ? ELSE printed_at END
       WHERE id = ?`,
      [
        nextStatus,
        updatedAt,
        actor.userId || null,
        actor.username || "",
        actor.clientUid || "",
        actor.shopName || "",
        nextStatus,
        updatedAt,
        jobId
      ]
    );
  } else {
    await db.run(
      "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
      [nextStatus, updatedAt, jobId]
    );
  }

  if (nextStatus === "printing") {
    const totalPages = Math.max(
      1,
      countSelectedPages(job.page_selection, Number(job.page_count) || 1) * Math.max(1, Number(job.copies) || 1)
    );
    await db.run(
      "UPDATE jobs SET print_progress_pages = 0, print_progress_total = ?, print_progress_updated_at = ? WHERE id = ?",
      [totalPages, updatedAt, jobId]
    );
  }

  if (nextStatus === "printed") {
    const totalPages = Math.max(
      1,
      countSelectedPages(job.page_selection, Number(job.page_count) || 1) * Math.max(1, Number(job.copies) || 1)
    );
    await db.run(
      "UPDATE jobs SET print_progress_pages = ?, print_progress_total = ?, print_progress_updated_at = ? WHERE id = ?",
      [totalPages, totalPages, updatedAt, jobId]
    );
  }

  await db.run(
    "INSERT INTO job_status_history (job_id, status, source, created_at) VALUES (?, ?, ?, ?)",
    [jobId, nextStatus, actor ? "desktop" : "system", updatedAt]
  );

  return getJobById(jobId);
}

export async function addJobStatusHistory(jobId, status, source = "system", createdAt = nowIso()) {
  const db = getDb();
  await db.run(
    "INSERT INTO job_status_history (job_id, status, source, created_at) VALUES (?, ?, ?, ?)",
    [jobId, status, source, createdAt]
  );
}

export async function listJobStatusHistory(jobId) {
  const db = getDb();
  return db.all(
    `SELECT status, source, created_at
     FROM job_status_history
     WHERE job_id = ?
     ORDER BY datetime(created_at) ASC, id ASC`,
    [jobId]
  );
}

export async function updateJobPrintProgress(jobId, pagesPrinted, totalPages = null) {
  const db = getDb();
  const job = await getJobById(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const fallbackTotal = Math.max(
    1,
    countSelectedPages(job.page_selection, Number(job.page_count) || 1) * Math.max(1, Number(job.copies) || 1)
  );
  const safeTotal = Number.isFinite(Number(totalPages)) && Number(totalPages) > 0
    ? Math.max(1, Math.floor(Number(totalPages)))
    : Math.max(1, Number(job.print_progress_total) || fallbackTotal);
  const safePrinted = Number.isFinite(Number(pagesPrinted))
    ? Math.max(0, Math.floor(Number(pagesPrinted)))
    : 0;
  const updatedAt = nowIso();

  await db.run(
    `UPDATE jobs
     SET print_progress_pages = ?, print_progress_total = ?, print_progress_updated_at = ?, updated_at = ?
     WHERE id = ?`,
    [safePrinted, safeTotal, updatedAt, updatedAt, jobId]
  );

  return getJobById(jobId);
}

export async function listQueues(clientId = null, userId = null) {
  const db = getDb();
  const rows = clientId && userId
    ? await db.all(
      `SELECT j.*, c.client_uid AS client_uid, c.shop_name AS shop_name, c.auto_payment_enabled AS auto_payment_enabled
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE j.client_id = ? AND j.assigned_user_id = ? AND COALESCE(j.is_archived, 0) = 0
       ORDER BY j.id DESC`,
      [clientId, userId]
    )
    : clientId
    ? await db.all(
      `SELECT j.*, c.client_uid AS client_uid, c.shop_name AS shop_name, c.auto_payment_enabled AS auto_payment_enabled
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE j.client_id = ? AND COALESCE(j.is_archived, 0) = 0
       ORDER BY j.id DESC`,
      [clientId]
    )
    : await db.all(
      `SELECT j.*, c.client_uid AS client_uid, c.shop_name AS shop_name, c.auto_payment_enabled AS auto_payment_enabled
       FROM jobs j
       LEFT JOIN clients c ON c.id = j.client_id
       WHERE COALESCE(j.is_archived, 0) = 0
       ORDER BY j.id DESC`
    );
  const byUpdatedAtAsc = (a, b) => {
    const left = Date.parse(a.updated_at || 0);
    const right = Date.parse(b.updated_at || 0);
    if (left !== right) {
      return left - right;
    }
    return Number(a.id) - Number(b.id);
  };

  return {
    paymentQueue: rows.filter((r) => r.status === "payment_pending"),
    verificationQueue: rows.filter((r) => r.status === "paid"),
    approvalQueue: rows.filter((r) => r.status === "approved").sort(byUpdatedAtAsc),
    printQueue: rows.filter((r) => r.status === "printing"),
    printedQueue: rows.filter((r) => r.status === "printed"),
    failedQueue: rows.filter((r) => r.status === "print_failed")
  };
}

function getRangeStartIso(range = "all") {
  const now = new Date();
  if (range === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  if (range === "7d") {
    return new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000)).toISOString();
  }
  if (range === "30d") {
    return new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000)).toISOString();
  }
  return null;
}

function normalizeAnalyticsRow(row) {
  return {
    totalJobs: Number(row?.total_jobs || 0),
    printedJobs: Number(row?.printed_jobs || 0),
    failedJobs: Number(row?.failed_jobs || 0),
    pendingJobs: Number(row?.pending_jobs || 0),
    totalPages: Number(row?.total_pages || 0),
    revenuePrinted: Number(row?.revenue_printed || 0),
    colorJobs: Number(row?.color_jobs || 0),
    bwJobs: Number(row?.bw_jobs || 0)
  };
}

export async function getAnalytics(clientId = null, range = "all", options = {}) {
  const db = getDb();
  const clauses = ["COALESCE(j.is_archived, 0) = 0", "j.status != 'draft_upload'"];
  const args = [];
  const userId = Number(options?.userId || 0);
  const exactDate = String(options?.date || "").trim();

  if (clientId) {
    clauses.push("j.client_id = ?");
    args.push(clientId);
  }

  if (Number.isFinite(userId) && userId > 0) {
    clauses.push("j.assigned_user_id = ?");
    args.push(userId);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(exactDate)) {
    clauses.push("substr(j.updated_at, 1, 10) = ?");
    args.push(exactDate);
  } else {
    const rangeStartIso = getRangeStartIso(range);
    if (rangeStartIso) {
    clauses.push("datetime(j.updated_at) >= datetime(?)");
    args.push(rangeStartIso);
    }
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const aggregateSql = `
       COUNT(*) AS total_jobs,
       SUM(CASE WHEN j.status = 'printed' THEN 1 ELSE 0 END) AS printed_jobs,
       SUM(CASE WHEN j.status = 'print_failed' THEN 1 ELSE 0 END) AS failed_jobs,
       SUM(CASE WHEN j.status IN ('payment_pending', 'paid', 'approved', 'printing') THEN 1 ELSE 0 END) AS pending_jobs,
       SUM(COALESCE(j.page_count, 0) * COALESCE(j.copies, 1)) AS total_pages,
       SUM(CASE WHEN j.status = 'printed' THEN COALESCE(j.total_price, 0) ELSE 0 END) AS revenue_printed,
       SUM(CASE WHEN j.color_mode = 'color' THEN 1 ELSE 0 END) AS color_jobs,
       SUM(CASE WHEN j.color_mode = 'bw' THEN 1 ELSE 0 END) AS bw_jobs`;

  const totals = await db.get(
    `SELECT ${aggregateSql}
     FROM jobs j
     ${whereSql}`,
    args
  );

  const recentLogs = await db.all(
    `SELECT
       j.id,
       j.queue_token,
       j.original_name,
       j.status,
       j.total_price,
       j.unit_price,
       j.page_count,
       j.page_selection,
       j.copies,
       j.color_mode,
       j.payment_provider,
       j.payment_verified_at,
       j.payment_verification_mode,
       j.payment_verified_by_username,
       j.updated_at,
       j.printed_at,
       j.client_id,
       j.assigned_user_id,
       u.username AS assigned_username,
       COALESCE(c.client_uid, j.printed_by_client_uid) AS client_uid,
       COALESCE(c.shop_name, j.printed_by_shop_name) AS shop_name,
       j.printed_by_user_id,
       j.printed_by_username
     FROM jobs j
     LEFT JOIN clients c ON c.id = j.client_id
     LEFT JOIN users u ON u.id = j.assigned_user_id
     ${whereSql}
     ORDER BY datetime(j.updated_at) DESC, j.id DESC
     LIMIT 25`,
    args
  );

  const shopSummaries = await db.all(
    `SELECT
       j.client_id,
       COALESCE(c.client_uid, j.printed_by_client_uid) AS client_uid,
       COALESCE(c.shop_name, j.printed_by_shop_name, 'Unknown Shop') AS shop_name,
       ${aggregateSql}
     FROM jobs j
     LEFT JOIN clients c ON c.id = j.client_id
     ${whereSql}
     GROUP BY j.client_id, client_uid, shop_name
     ORDER BY revenue_printed DESC, total_jobs DESC`,
    args
  );

  const userSummaries = await db.all(
    `SELECT
       j.client_id,
       COALESCE(c.client_uid, j.printed_by_client_uid) AS client_uid,
       COALESCE(c.shop_name, j.printed_by_shop_name, 'Unknown Shop') AS shop_name,
       j.assigned_user_id AS user_id,
       COALESCE(u.username, j.printed_by_username, 'Unassigned') AS username,
       ${aggregateSql}
     FROM jobs j
     LEFT JOIN clients c ON c.id = j.client_id
     LEFT JOIN users u ON u.id = j.assigned_user_id
     ${whereSql}
     GROUP BY j.client_id, client_uid, shop_name, j.assigned_user_id, username
     ORDER BY shop_name ASC, revenue_printed DESC, total_jobs DESC`,
    args
  );

  const dailySummaries = await db.all(
    `SELECT
       substr(j.updated_at, 1, 10) AS day,
       ${aggregateSql}
     FROM jobs j
     ${whereSql}
     GROUP BY day
     ORDER BY day DESC
     LIMIT 31`,
    args
  );

  return {
    range,
    date: /^\d{4}-\d{2}-\d{2}$/.test(exactDate) ? exactDate : "",
    ...normalizeAnalyticsRow(totals),
    shopSummaries: shopSummaries.map((row) => ({
      clientId: row.client_id == null ? null : Number(row.client_id),
      clientUid: row.client_uid || "",
      shopName: row.shop_name || "Unknown Shop",
      ...normalizeAnalyticsRow(row)
    })),
    userSummaries: userSummaries.map((row) => ({
      clientId: row.client_id == null ? null : Number(row.client_id),
      clientUid: row.client_uid || "",
      shopName: row.shop_name || "Unknown Shop",
      userId: row.user_id == null ? null : Number(row.user_id),
      username: row.username || "Unassigned",
      ...normalizeAnalyticsRow(row)
    })),
    dailySummaries: dailySummaries.map((row) => ({
      day: row.day || "",
      ...normalizeAnalyticsRow(row)
    })),
    recentLogs: recentLogs.map((row) => {
      const copies = Math.max(1, Number(row.copies || 1));
      const selectedPagesPerCopy = countSelectedPages(row.page_selection, Number(row.page_count || 1));
      return {
        ...row,
        copies,
        unit_price: Number(row.unit_price || 0),
        page_count: Number(row.page_count || 0),
        page_selection: row.page_selection || "all",
        selected_pages_per_copy: selectedPagesPerCopy,
        effective_pages: Math.max(1, selectedPagesPerCopy * copies),
        color_mode: row.color_mode || "bw",
        total_price: Number(row.total_price || 0)
      };
    })
  };
}

function scheduleCleanup(jobId, onQueueChanged) {
  if (cleanupTimers.has(jobId)) {
    return;
  }

  const timeoutMs = config.retentionMinutes * 60 * 1000;
  const timer = setTimeout(async () => {
    try {
      const db = getDb();
      const job = await getJobById(jobId);
      if (!job) {
        return;
      }

      if (job.file_path && fs.existsSync(job.file_path)) {
        fs.unlinkSync(job.file_path);
      }
      // Keep analytics/history rows. Cleanup should only remove the physical file.
      await db.run("UPDATE jobs SET updated_at = ? WHERE id = ?", [nowIso(), jobId]);
      onQueueChanged?.();
    } catch (error) {
      console.error("Cleanup failed", error);
    } finally {
      cleanupTimers.delete(jobId);
    }
  }, timeoutMs);

  cleanupTimers.set(jobId, timer);
}

export function scheduleCleanupForJob(jobId, onQueueChanged) {
  scheduleCleanup(jobId, onQueueChanged);
}

export async function cancelJobAndDeleteFile(jobId) {
  const db = getDb();
  const job = await getJobById(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  if (job.status === "printing") {
    throw new Error("Cannot cancel while job is actively printing");
  }

  const timer = cleanupTimers.get(job.id);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(job.id);
  }

  if (job.file_path && fs.existsSync(job.file_path)) {
    fs.unlinkSync(job.file_path);
  }

  // Soft-archive the job so queue UI hides it, but analytics/history remain intact.
  await db.run(
    "UPDATE jobs SET is_archived = 1, updated_at = ? WHERE id = ?",
    [nowIso(), job.id]
  );
  return getJobById(job.id);
}

export async function markDownloaded(jobId) {
  const db = getDb();
  await db.run("UPDATE jobs SET downloaded_by_desktop = 1, updated_at = ? WHERE id = ?", [
    nowIso(),
    jobId
  ]);
  return getJobById(jobId);
}
