import webPush from "web-push";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { formatQueueToken } from "./utils.js";

const STATUS_MESSAGES = {
  payment_pending: "Payment is pending.",
  paid: "Payment received. The shop is checking your print.",
  approved: "Your document is ready for printing.",
  printing: "Printing has started.",
  printed: "Your print is complete.",
  print_failed: "Printing failed. Please contact the shop.",
  rejected: "The shop rejected this print job."
};

let configured = false;

function configureWebPush() {
  if (configured) {
    return true;
  }
  if (!config.webPushPublicKey || !config.webPushPrivateKey) {
    return false;
  }
  webPush.setVapidDetails(config.webPushSubject, config.webPushPublicKey, config.webPushPrivateKey);
  configured = true;
  return true;
}

export function getPushPublicConfig() {
  return {
    enabled: Boolean(config.webPushPublicKey && config.webPushPrivateKey),
    publicKey: config.webPushPublicKey || ""
  };
}

export async function savePushSubscription({ userUid, userId, jobId = null, subscription }) {
  const endpoint = String(subscription?.endpoint || "").trim();
  if (!userUid || !userId || !endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    const error = new Error("Invalid push subscription");
    error.statusCode = 400;
    throw error;
  }

  const db = getDb();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO push_subscriptions (user_uid, user_id, job_id, endpoint, subscription_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_uid = excluded.user_uid,
       user_id = excluded.user_id,
       job_id = COALESCE(excluded.job_id, push_subscriptions.job_id),
       subscription_json = excluded.subscription_json,
       updated_at = excluded.updated_at`,
    [userUid, userId, jobId || null, endpoint, JSON.stringify(subscription), now, now]
  );
}

export async function attachPushSubscriptionToJob({ userUid, endpoint, jobId }) {
  if (!userUid || !endpoint || !jobId) {
    return;
  }
  const db = getDb();
  await db.run(
    "UPDATE push_subscriptions SET job_id = ?, updated_at = ? WHERE user_uid = ? AND endpoint = ?",
    [jobId, new Date().toISOString(), userUid, endpoint]
  );
}

function notificationPayload(job, eventType = "status") {
  const status = String(job?.status || "").toLowerCase();
  const token = job?.queue_token || formatQueueToken(job?.id || 0);
  const title = eventType === "progress" ? "Print Panda progress updated" : "Print Panda status updated";
  const body = eventType === "progress"
    ? `Job ${token}: ${Number(job.print_progress_pages || 0)}/${Number(job.print_progress_total || 0)} pages printed.`
    : `Job ${token}: ${STATUS_MESSAGES[status] || "Status updated."}`;
  return {
    title,
    body,
    url: job?.user_uid ? `/u/${encodeURIComponent(job.user_uid)}?screen=status&jobId=${encodeURIComponent(String(job.id))}` : "/",
    jobId: job?.id,
    status,
    queueToken: token
  };
}

async function subscriptionsForJob(job) {
  const db = getDb();
  return db.all(
    `SELECT ps.id, ps.endpoint, ps.subscription_json
     FROM push_subscriptions ps
     WHERE ps.job_id = ?
        OR (ps.user_id = ? AND ps.user_uid = ?)`,
    [job.id, job.assigned_user_id, job.user_uid || ""]
  );
}

export async function notifyJobPush(job, eventType = "status") {
  if (!configureWebPush() || !job?.id) {
    return { sent: 0, skipped: true };
  }

  const rows = await subscriptionsForJob(job);
  if (!rows.length) {
    return { sent: 0, skipped: false };
  }

  const db = getDb();
  const payload = JSON.stringify(notificationPayload(job, eventType));
  let sent = 0;
  await Promise.all(rows.map(async (row) => {
    try {
      await webPush.sendNotification(JSON.parse(row.subscription_json), payload);
      sent += 1;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await db.run("DELETE FROM push_subscriptions WHERE id = ?", [row.id]);
      } else {
        console.warn("Push notification failed", error?.message || error);
      }
    }
  }));
  return { sent, skipped: false };
}
