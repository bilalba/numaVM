export interface IVMLifecycleHook {
  /** Called before VM creation — return extra dm.* kernel cmdline args. */
  getExtraKernelArgs?(ctx: VMProvisionContext): Promise<string[]>;
  /** Called before VM is destroyed. */
  onVMDestroy?(ctx: VMDestroyContext): Promise<void>;
  /** Return LLM spend/budget for a user (commercial only). */
  getLLMUsage?(userId: string): Promise<{ spend: number; budget: number } | null>;
}

export interface VMProvisionContext {
  vmId: string;
  userId: string;
}

export interface VMDestroyContext {
  vmId: string;
  userId: string;
}
