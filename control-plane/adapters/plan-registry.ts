// Plan registry adapter — defines plan limits and trial configuration

export interface PlanLimits {
  max_ram_mib: number;
  max_data_bytes: number;
  valid_mem_sizes: number[];
  max_disk_gib: number;
  valid_disk_sizes: number[];
  label: string;
  max_llm_budget?: number;
}

export interface TrialConfig {
  duration_ms: number;
  initial_plan: string;
}

export interface IPlanRegistry {
  getPlanLimits(plan: string): PlanLimits | null;
  getDefaultPlan(): string;
  getTrialConfig(): TrialConfig | null;
  getAvailablePlans(): string[];
}
