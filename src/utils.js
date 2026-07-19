export function nowIso() {
  return new Date().toISOString();
}

export function getIsoDatePart(value) {
  const date = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : nowIso().slice(0, 10);
}

export function formatQueueToken(sequenceNumber) {
  const safeSequence = Number(sequenceNumber) > 0 ? Number(sequenceNumber) : 1;
  return `PP-${safeSequence}`;
}

export function safeInt(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function toBooleanInt(value) {
  return value === true || value === "true" || value === "1" ? 1 : 0;
}
