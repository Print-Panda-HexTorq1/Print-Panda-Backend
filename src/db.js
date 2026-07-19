import fs from "node:fs";
import crypto from "node:crypto";
import { open } from "sqlite";
import sqlite3 from "sqlite3";
import { config } from "./config.js";
import { formatQueueToken, getIsoDatePart } from "./utils.js";

let db;

function generateUserUid() {
  return `u_${crypto.randomBytes(6).toString("hex")}`;
}

export async function initDb() {
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  db = await open({
    filename: config.dbPath,
    driver: sqlite3.Database
  });

  await db.exec("PRAGMA foreign_keys = ON");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uid TEXT NOT NULL UNIQUE,
      shop_name TEXT NOT NULL,
      upi_id TEXT NOT NULL DEFAULT '',
      upi_name TEXT NOT NULL DEFAULT '',
      bw_price INTEGER NOT NULL DEFAULT 3,
      color_price INTEGER NOT NULL DEFAULT 10,
      auto_payment_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      user_uid TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      printed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      printed_by_username TEXT NOT NULL DEFAULT '',
      printed_by_client_uid TEXT NOT NULL DEFAULT '',
      printed_by_shop_name TEXT NOT NULL DEFAULT '',
      printed_at TEXT,
      queue_token TEXT,
      customer_name TEXT,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 1,
      copies INTEGER NOT NULL,
      color_mode TEXT NOT NULL,
      page_selection TEXT NOT NULL,
      orientation TEXT NOT NULL,
      paper_size TEXT NOT NULL,
      duplex INTEGER NOT NULL DEFAULT 0,
      unit_price INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      status TEXT NOT NULL,
      payment_provider TEXT NOT NULL DEFAULT 'upi',
      payment_order_id TEXT,
      pay_panda_payment_id TEXT,
      pay_panda_checkout_url TEXT,
      pay_panda_status TEXT,
      pay_panda_bank_rrn TEXT,
      payment_verified_at TEXT,
      downloaded_by_desktop INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      print_progress_pages INTEGER NOT NULL DEFAULT 0,
      print_progress_total INTEGER NOT NULL DEFAULT 0,
      print_progress_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS job_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL
    );
  `);

  const columns = await db.all("PRAGMA table_info(jobs)");
  const hasQueueToken = columns.some((c) => c.name === "queue_token");
  const hasPageCount = columns.some((c) => c.name === "page_count");
  const hasClientId = columns.some((c) => c.name === "client_id");
  const hasAssignedUserId = columns.some((c) => c.name === "assigned_user_id");
  const hasPrintedByUserId = columns.some((c) => c.name === "printed_by_user_id");  const hasPrintedByUsername = columns.some((c) => c.name === "printed_by_username");
  const hasPrintedByClientUid = columns.some((c) => c.name === "printed_by_client_uid");
  const hasPrintedByShopName = columns.some((c) => c.name === "printed_by_shop_name");
  const hasPrintedAt = columns.some((c) => c.name === "printed_at");
  const hasIsArchived = columns.some((c) => c.name === "is_archived");
  const hasPrintProgressPages = columns.some((c) => c.name === "print_progress_pages");
  const hasPrintProgressTotal = columns.some((c) => c.name === "print_progress_total");
  const hasPrintProgressUpdatedAt = columns.some((c) => c.name === "print_progress_updated_at");
  if (!hasQueueToken) {
    await db.exec("ALTER TABLE jobs ADD COLUMN queue_token TEXT");
  }
  if (!hasPageCount) {
    await db.exec("ALTER TABLE jobs ADD COLUMN page_count INTEGER NOT NULL DEFAULT 1");
  }
  if (!hasClientId) {
    await db.exec("ALTER TABLE jobs ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL");
  }
  if (!hasAssignedUserId) {
    await db.exec("ALTER TABLE jobs ADD COLUMN assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  }
  if (!hasPrintedByUserId) {
    await db.exec("ALTER TABLE jobs ADD COLUMN printed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL");
  }
  if (!hasPrintedByUsername) {
    await db.exec("ALTER TABLE jobs ADD COLUMN printed_by_username TEXT NOT NULL DEFAULT ''");
  }
  if (!hasPrintedByClientUid) {
    await db.exec("ALTER TABLE jobs ADD COLUMN printed_by_client_uid TEXT NOT NULL DEFAULT ''");
  }
  if (!hasPrintedByShopName) {
    await db.exec("ALTER TABLE jobs ADD COLUMN printed_by_shop_name TEXT NOT NULL DEFAULT ''");
  }
  if (!hasPrintedAt) {
    await db.exec("ALTER TABLE jobs ADD COLUMN printed_at TEXT");
  }
  if (!hasIsArchived) {
    await db.exec("ALTER TABLE jobs ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasPrintProgressPages) {
    await db.exec("ALTER TABLE jobs ADD COLUMN print_progress_pages INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasPrintProgressTotal) {
    await db.exec("ALTER TABLE jobs ADD COLUMN print_progress_total INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasPrintProgressUpdatedAt) {
    await db.exec("ALTER TABLE jobs ADD COLUMN print_progress_updated_at TEXT");
  }
  if (!columns.some((c) => c.name === "payment_provider")) {
    await db.exec("ALTER TABLE jobs ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'upi'");
  }
  if (!columns.some((c) => c.name === "payment_order_id")) {
    await db.exec("ALTER TABLE jobs ADD COLUMN payment_order_id TEXT");
  }
  if (!columns.some((c) => c.name === "pay_panda_payment_id")) {
    await db.exec("ALTER TABLE jobs ADD COLUMN pay_panda_payment_id TEXT");
  }
  if (!columns.some((c) => c.name === "pay_panda_checkout_url")) {
    await db.exec("ALTER TABLE jobs ADD COLUMN pay_panda_checkout_url TEXT");
  }
  if (!columns.some((c) => c.name === "pay_panda_status")) {
    await db.exec("ALTER TABLE jobs ADD COLUMN pay_panda_status TEXT");
  }
  if (!columns.some((c) => c.name === "pay_panda_bank_rrn")) {
    await db.exec("ALTER TABLE jobs ADD COLUMN pay_panda_bank_rrn TEXT");
  }
  if (!columns.some((c) => c.name === "payment_verified_at")) {
    await db.exec("ALTER TABLE jobs ADD COLUMN payment_verified_at TEXT");
  }

  const clientCols = await db.all("PRAGMA table_info(clients)");
  if (!clientCols.some((c) => c.name === "upi_id")) {
    await db.exec("ALTER TABLE clients ADD COLUMN upi_id TEXT NOT NULL DEFAULT ''");
  }
  if (!clientCols.some((c) => c.name === "upi_name")) {
    await db.exec("ALTER TABLE clients ADD COLUMN upi_name TEXT NOT NULL DEFAULT ''");
  }
  if (!clientCols.some((c) => c.name === "bw_price")) {
    await db.exec("ALTER TABLE clients ADD COLUMN bw_price INTEGER NOT NULL DEFAULT 3");
  }
  if (!clientCols.some((c) => c.name === "color_price")) {
    await db.exec("ALTER TABLE clients ADD COLUMN color_price INTEGER NOT NULL DEFAULT 10");
  }
  if (!clientCols.some((c) => c.name === "auto_payment_enabled")) {
    await db.exec("ALTER TABLE clients ADD COLUMN auto_payment_enabled INTEGER NOT NULL DEFAULT 1");
  }

  const userCols = await db.all("PRAGMA table_info(users)");
  if (!userCols.some((c) => c.name === "user_uid")) {
    await db.exec("ALTER TABLE users ADD COLUMN user_uid TEXT");
  }

  const usersWithoutUid = await db.all("SELECT id FROM users WHERE user_uid IS NULL OR trim(user_uid) = ''");
  for (const user of usersWithoutUid) {
    let uid = generateUserUid();
    let exists = await db.get("SELECT id FROM users WHERE user_uid = ?", [uid]);
    while (exists) {
      uid = generateUserUid();
      exists = await db.get("SELECT id FROM users WHERE user_uid = ?", [uid]);
    }
    await db.run("UPDATE users SET user_uid = ? WHERE id = ?", [uid, user.id]);
  }

  await db.exec("DROP INDEX IF EXISTS idx_jobs_queue_token");

  const jobs = await db.all("SELECT id, created_at FROM jobs ORDER BY created_at ASC, id ASC");
  const dailySequence = new Map();
  for (const job of jobs) {
    const datePart = getIsoDatePart(job.created_at);
    const nextSequence = (dailySequence.get(datePart) || 0) + 1;
    dailySequence.set(datePart, nextSequence);
    await db.run("UPDATE jobs SET queue_token = ? WHERE id = ?", [formatQueueToken(nextSequence), job.id]);
  }

  // Backfill any old jobs so each shop user has isolated queues.
  await db.exec(`
    UPDATE jobs
    SET assigned_user_id = (
      SELECT u.id
      FROM users u
      WHERE u.client_id = jobs.client_id
      ORDER BY u.id ASC
      LIMIT 1
    )
    WHERE client_id IS NOT NULL
      AND (assigned_user_id IS NULL OR assigned_user_id = 0)
  `);

  await db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_queue_token ON jobs(queue_token)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_job_status_history_job_created ON job_status_history(job_id, created_at)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_uid ON clients(client_uid)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(user_uid)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_payment_order ON jobs(payment_order_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_pay_panda_payment ON jobs(pay_panda_payment_id)");

  return db;
}

export function getDb() {
  if (!db) {
    throw new Error("Database is not initialized");
  }
  return db;
}
