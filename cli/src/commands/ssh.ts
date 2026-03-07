import { Command } from "commander";
import { spawn } from "node:child_process";
import { api } from "../client.js";
import { getApiUrl } from "../config.js";
import { spin } from "../util/spinner.js";

interface VM {
  id: string;
  slug: string;
  name: string;
  status: string;
  ssh_port?: number;
}

export function registerSshCommand(program: Command) {
  program
    .command("ssh <name>")
    .description("SSH into a VM")
    .option("--user <user>", "SSH user", "dev")
    .action(async (name: string, opts: { user: string }) => {
      const spinner = spin("Resolving VM...");

      try {
        const vm = await resolveVM(name);
        spinner.stop();

        if (!vm.ssh_port) {
          console.error("VM does not have an SSH port assigned.");
          process.exit(1);
        }

        if (vm.status !== "running") {
          console.error(`VM is ${vm.status}. It must be running to SSH in.`);
          process.exit(1);
        }

        const host = new URL(getApiUrl()).hostname;
        const args = [
          `${opts.user}@${host}`,
          "-p", String(vm.ssh_port),
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
        ];

        const child = spawn("ssh", args, { stdio: "inherit" });
        child.on("exit", (code) => process.exit(code ?? 0));
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}

async function resolveVM(nameOrId: string): Promise<VM> {
  try {
    return await api<VM>(`/vms/${nameOrId}`);
  } catch {
    // Fall through
  }
  const vms = await api<VM[]>("/vms");
  const match = vms.find(
    (e) => e.name === nameOrId || e.slug === nameOrId || e.id === nameOrId,
  );
  if (!match) {
    throw new Error(`VM "${nameOrId}" not found`);
  }
  return api<VM>(`/vms/${match.id}`);
}
