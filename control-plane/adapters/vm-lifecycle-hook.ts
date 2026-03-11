export interface IVMLifecycleHook {
  /** Called before VM creation — return extra dm.* kernel cmdline args. */
  getExtraKernelArgs?(ctx: VMProvisionContext): Promise<string[]>;
  /** Called before VM is destroyed. */
  onVMDestroy?(ctx: VMDestroyContext): Promise<void>;
}

export interface VMProvisionContext {
  vmId: string;
  userId: string;
}

export interface VMDestroyContext {
  vmId: string;
  userId: string;
}
