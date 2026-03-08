import type { IPlanRegistry, PlanLimits, TrialConfig } from "../plan-registry.js";

const COMMUNITY_LIMITS: PlanLimits = {
  max_ram_mib: 4096,
  max_data_bytes: 100 * 1024 ** 3, // 100 GB
  valid_mem_sizes: [256, 512, 768, 1024, 1280, 1536, 2048, 3072, 4096],
  max_disk_gib: 100,
  valid_disk_sizes: [1, 2, 5, 10, 20, 50, 100],
  label: "Community",
};

/**
 * OSS default: single generous "community" plan, no trials.
 * Returns community limits for ANY plan name (backward compat for existing DBs).
 */
export class CommunityPlanRegistry implements IPlanRegistry {
  getPlanLimits(_plan: string): PlanLimits {
    return COMMUNITY_LIMITS;
  }

  getDefaultPlan(): string {
    return "community";
  }

  getTrialConfig(): TrialConfig | null {
    return null;
  }

  getAvailablePlans(): string[] {
    return ["community"];
  }
}
