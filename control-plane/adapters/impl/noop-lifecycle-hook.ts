import type { IVMLifecycleHook, VMProvisionContext, VMDestroyContext } from "../vm-lifecycle-hook.js";

export class NoopLifecycleHook implements IVMLifecycleHook {
  async getExtraKernelArgs(_ctx: VMProvisionContext): Promise<string[]> {
    return [];
  }

  async onVMDestroy(_ctx: VMDestroyContext): Promise<void> {
    // no-op
  }
}
