import { getDatabase } from "../adapters/providers.js";

interface SubsystemStatus {
  status: "ok" | "error";
  error?: string;
}

interface HealthStats {
  status: "ok" | "degraded";
  subsystems: {
    database: SubsystemStatus;
  };
  stats: {
    vms: Record<string, number>;
    runningVMs: number;
  };
}

export async function getHealthStats(): Promise<HealthStats> {
  let dbStatus: SubsystemStatus = { status: "ok" };
  let vmsByStatus: Record<string, number> = {};
  let runningVMs = 0;

  // Check database
  try {
    const db = getDatabase();
    db.raw("SELECT 1");
    const rows = db.raw<{ status: string; count: number }>("SELECT status, COUNT(*) as count FROM vms GROUP BY status");
    for (const row of rows) {
      vmsByStatus[row.status] = row.count;
    }
    runningVMs = vmsByStatus["running"] || 0;
  } catch (err: any) {
    dbStatus = { status: "error", error: err.message };
  }

  return {
    status: dbStatus.status === "ok" ? "ok" : "degraded",
    subsystems: {
      database: dbStatus,
    },
    stats: {
      vms: vmsByStatus,
      runningVMs,
    },
  };
}
