import nodemailer from "nodemailer";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { getAnalytics } from "./queueService.js";

let lastSentDate = "";

function hasMailConfig() {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPass && config.mailFrom);
}

function createTransporter() {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRs(value) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN")}`;
}

function formatDateLocal(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function previousReportDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return formatDateLocal(date);
}

function metricCards(analytics) {
  const metrics = [
    ["Total Jobs", analytics.totalJobs],
    ["Printed", analytics.printedJobs],
    ["Failed", analytics.failedJobs],
    ["Pending", analytics.pendingJobs],
    ["Pages", analytics.totalPages],
    ["Revenue", formatRs(analytics.revenuePrinted)],
    ["B/W Jobs", analytics.bwJobs],
    ["Color Jobs", analytics.colorJobs]
  ];
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr>
        ${metrics.map(([label, value]) => `
          <td style="width:25%;padding:8px;">
            <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#ffffff;">
              <div style="font-size:12px;color:#64748b;">${escapeHtml(label)}</div>
              <div style="font-size:20px;font-weight:700;color:#111827;margin-top:4px;">${escapeHtml(value)}</div>
            </div>
          </td>
        `).join("")}
      </tr>
    </table>
  `;
}

function summaryTable(title, rows, columns) {
  return `
    <h3 style="font-size:16px;margin:22px 0 8px;color:#111827;">${escapeHtml(title)}</h3>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr>
          ${columns.map((column) => `<th style="text-align:left;border-bottom:1px solid #e5e7eb;padding:8px;color:#475569;">${escapeHtml(column.label)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${rows.length ? rows.map((row) => `
          <tr>
            ${columns.map((column) => `<td style="border-bottom:1px solid #f1f5f9;padding:8px;color:#111827;">${escapeHtml(column.render(row))}</td>`).join("")}
          </tr>
        `).join("") : `<tr><td colspan="${columns.length}" style="padding:12px;color:#64748b;">No records for this date.</td></tr>`}
      </tbody>
    </table>
  `;
}

function reportHtml({ title, date, analytics, sections = [] }) {
  return `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#111827;">
      <div style="max-width:920px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
        <h1 style="font-size:22px;margin:0;">${escapeHtml(title)}</h1>
        <p style="margin:6px 0 0;color:#64748b;">Daily analytics for ${escapeHtml(date)}</p>
        ${metricCards(analytics)}
        ${sections.join("")}
        <p style="margin-top:24px;font-size:12px;color:#94a3b8;">Generated automatically by Print Panda.</p>
      </div>
    </div>
  `;
}

function logsSection(logs) {
  return summaryTable("Recent Jobs", logs || [], [
    { label: "Token", render: (row) => row.queue_token || `PP-${row.id}` },
    { label: "Shop", render: (row) => row.shop_name || "-" },
    { label: "User", render: (row) => row.assigned_username || row.printed_by_username || "-" },
    { label: "File", render: (row) => row.original_name || "-" },
    { label: "Status", render: (row) => row.status || "-" },
    { label: "Pages", render: (row) => row.effective_pages || row.page_count || 0 },
    { label: "Revenue", render: (row) => formatRs(row.total_price) },
    { label: "Updated", render: (row) => row.updated_at || "-" }
  ]);
}

function userSummarySection(rows) {
  return summaryTable("User Summary", rows || [], [
    { label: "User", render: (row) => row.username || "-" },
    { label: "Jobs", render: (row) => row.totalJobs },
    { label: "Printed", render: (row) => row.printedJobs },
    { label: "Failed", render: (row) => row.failedJobs },
    { label: "Pages", render: (row) => row.totalPages },
    { label: "Revenue", render: (row) => formatRs(row.revenuePrinted) }
  ]);
}

function shopSummarySection(rows) {
  return summaryTable("Shop Summary", rows || [], [
    { label: "Shop", render: (row) => row.shopName || "-" },
    { label: "Client ID", render: (row) => row.clientUid || row.clientId || "-" },
    { label: "Jobs", render: (row) => row.totalJobs },
    { label: "Printed", render: (row) => row.printedJobs },
    { label: "Failed", render: (row) => row.failedJobs },
    { label: "Pages", render: (row) => row.totalPages },
    { label: "Revenue", render: (row) => formatRs(row.revenuePrinted) }
  ]);
}

async function sendReport(transporter, { to, subject, html }) {
  if (!String(to || "").trim()) {
    return { skipped: true };
  }
  await transporter.sendMail({
    from: config.mailFrom,
    to,
    subject,
    html
  });
  return { sent: true };
}

export async function sendDailyAnalyticsReports(date = previousReportDate()) {
  if (!hasMailConfig()) {
    console.warn("Daily email reports skipped: SMTP credentials are not configured.");
    return { sent: 0, skipped: true, date };
  }

  const db = getDb();
  const transporter = createTransporter();
  const users = await db.all(`
    SELECT u.id, u.username, u.email, u.client_id, c.shop_name
    FROM users u
    JOIN clients c ON c.id = u.client_id
    WHERE trim(COALESCE(u.email, '')) <> ''
    ORDER BY c.shop_name ASC, u.username ASC
  `);
  const clients = await db.all(`
    SELECT id, shop_name, email
    FROM clients
    WHERE trim(COALESCE(email, '')) <> ''
    ORDER BY shop_name ASC
  `);

  let sent = 0;
  for (const user of users) {
    const analytics = await getAnalytics(user.client_id, "all", { userId: user.id, date });
    const result = await sendReport(transporter, {
      to: user.email,
      subject: `Print Panda daily report - ${user.username} - ${date}`,
      html: reportHtml({
        title: `${user.shop_name} - ${user.username}`,
        date,
        analytics,
        sections: [logsSection(analytics.recentLogs)]
      })
    });
    if (result.sent) sent += 1;
  }

  for (const client of clients) {
    const analytics = await getAnalytics(client.id, "all", { date });
    const result = await sendReport(transporter, {
      to: client.email,
      subject: `Print Panda shop summary - ${client.shop_name} - ${date}`,
      html: reportHtml({
        title: `${client.shop_name} - Shop Summary`,
        date,
        analytics,
        sections: [userSummarySection(analytics.userSummaries), logsSection(analytics.recentLogs)]
      })
    });
    if (result.sent) sent += 1;
  }

  if (config.superAdminEmail) {
    const analytics = await getAnalytics(null, "all", { date });
    const result = await sendReport(transporter, {
      to: config.superAdminEmail,
      subject: `Print Panda full analytics - ${date}`,
      html: reportHtml({
        title: "Print Panda - Full Platform Analytics",
        date,
        analytics,
        sections: [
          shopSummarySection(analytics.shopSummaries),
          userSummarySection(analytics.userSummaries),
          logsSection(analytics.recentLogs)
        ]
      })
    });
    if (result.sent) sent += 1;
  }

  return { sent, skipped: false, date };
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(config.dailyReportHour, config.dailyReportMinute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return Math.max(1000, next.getTime() - now.getTime());
}

export function startDailyEmailReports() {
  const scheduleNext = () => {
    setTimeout(async () => {
      try {
        const date = previousReportDate();
        if (lastSentDate !== date) {
          const result = await sendDailyAnalyticsReports(date);
          lastSentDate = date;
          console.log(`Daily email reports completed for ${date}: sent=${result.sent || 0}`);
        }
      } catch (error) {
        console.error("Daily email reports failed", error);
      } finally {
        scheduleNext();
      }
    }, msUntilNextRun());
  };

  scheduleNext();
  console.log(`Daily email reports scheduled at ${String(config.dailyReportHour).padStart(2, "0")}:${String(config.dailyReportMinute).padStart(2, "0")} server time.`);
}
