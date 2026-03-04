export function relativeTime(dateStr: string): string {
  const now = Date.now();
  // SQLite CURRENT_TIMESTAMP returns UTC as "YYYY-MM-DD HH:MM:SS" (no timezone).
  // Browsers parse this as local time, so append "Z" to force UTC interpretation.
  const normalized = dateStr.includes("T") || dateStr.includes("Z") ? dateStr : dateStr.replace(" ", "T") + "Z";
  const date = new Date(normalized).getTime();
  const diff = now - date;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
