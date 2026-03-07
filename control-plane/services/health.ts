import { db } from "../db/client.js";

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
    activeAgentSessions: number;
  };
}

export async function getHealthStats(): Promise<HealthStats> {
  let dbStatus: SubsystemStatus = { status: "ok" };
  let vmsByStatus: Record<string, number> = {};
  let runningVMs = 0;
  let activeAgentSessions = 0;

  // Check database
  try {
    db.prepare("SELECT 1").get();
    const rows = db.prepare("SELECT status, COUNT(*) as count FROM vms GROUP BY status").all() as { status: string; count: number }[];
    for (const row of rows) {
      vmsByStatus[row.status] = row.count;
    }
    runningVMs = vmsByStatus["running"] || 0;
    const sessionRow = db.prepare("SELECT COUNT(*) as count FROM agent_sessions WHERE status NOT IN ('archived')").get() as { count: number };
    activeAgentSessions = sessionRow.count;
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
      activeAgentSessions,
    },
  };
}
