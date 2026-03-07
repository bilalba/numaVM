import { Command } from "commander";
import { api } from "../client.js";
import { table } from "../util/table.js";
import { spin } from "../util/spinner.js";

interface VM {
  id: string;
  slug: string;
  name: string;
  status: string;
  url?: string;
  repo_url?: string;
  ssh_port?: number;
  app_port?: number;
  vm_ip?: string;
  created_at?: string;
}

export function registerVMsCommands(program: Command) {
  const vms = program
    .command("vms")
    .description("Manage VMs");

  vms
    .command("list")
    .description("List all VMs")
    .action(async () => {
      const isJson = program.opts().json;
      const spinner = spin("Fetching VMs...");

      try {
        const list = await api<VM[]>("/vms");
        spinner.stop();

        if (isJson) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }

        if (list.length === 0) {
          console.log("No VMs found. Create one with `numavm vms create <name>`.");
          return;
        }

        console.log(
          table(
            ["Name", "Status", "URL"],
            list.map((e) => [e.name || e.slug, e.status, e.url || ""]),
          ),
        );
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  vms
    .command("create <name>")
    .description("Create a new VM")
    .option("--repo <owner/repo>", "Use existing GitHub repo")
    .action(async (name: string, opts: { repo?: string }) => {
      const isJson = program.opts().json;
      const spinner = spin(`Creating VM "${name}"...`);

      try {
        const body: Record<string, string> = { name };
        if (opts.repo) body.gh_repo = opts.repo;

        const vm = await api<VM>("/vms", {
          method: "POST",
          body: JSON.stringify(body),
        });
        spinner.stop();

        if (isJson) {
          console.log(JSON.stringify(vm, null, 2));
          return;
        }

        console.log(`VM "${name}" created!`);
        if (vm.url) console.log(`  URL:  ${vm.url}`);
        if (vm.repo_url) console.log(`  Repo: ${vm.repo_url}`);
        if (vm.ssh_port) console.log(`  SSH:  ssh dev@${new URL(vm.url || "").hostname} -p ${vm.ssh_port}`);
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  vms
    .command("info <name>")
    .description("Show VM details")
    .action(async (name: string) => {
      const isJson = program.opts().json;
      const spinner = spin("Fetching VM...");

      try {
        const vm = await resolveVM(name);
        spinner.stop();

        if (isJson) {
          console.log(JSON.stringify(vm, null, 2));
          return;
        }

        console.log(`Name:    ${vm.name || vm.slug}`);
        console.log(`Status:  ${vm.status}`);
        if (vm.url) console.log(`URL:     ${vm.url}`);
        if (vm.repo_url) console.log(`Repo:    ${vm.repo_url}`);
        if (vm.ssh_port) console.log(`SSH:     port ${vm.ssh_port}`);
        if (vm.vm_ip) console.log(`VM IP:   ${vm.vm_ip}`);
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  vms
    .command("destroy <name>")
    .description("Destroy a VM")
    .option("--yes", "Skip confirmation")
    .action(async (name: string, opts: { yes?: boolean }) => {
      const vm = await resolveVM(name);

      if (!opts.yes) {
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Destroy VM "${vm.name || vm.slug}"? This cannot be undone. [y/N] `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          console.log("Aborted.");
          return;
        }
      }

      const spinner = spin("Destroying VM...");
      try {
        await api(`/vms/${vm.id}`, { method: "DELETE" });
        spinner.stop();
        console.log(`VM "${vm.name || vm.slug}" destroyed.`);
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  vms
    .command("pause <name>")
    .description("Snapshot and pause a VM")
    .action(async (name: string) => {
      const vm = await resolveVM(name);
      const spinner = spin("Pausing VM...");

      try {
        await api(`/vms/${vm.id}/pause`, { method: "POST" });
        spinner.stop();
        console.log(`VM "${vm.name || vm.slug}" paused.`);
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}

async function resolveVM(nameOrId: string): Promise<VM> {
  // Try direct ID lookup first
  try {
    return await api<VM>(`/vms/${nameOrId}`);
  } catch {
    // Fall through to list-based lookup
  }

  // Search by name/slug in the list
  const vms = await api<VM[]>("/vms");
  const match = vms.find(
    (e) => e.name === nameOrId || e.slug === nameOrId || e.id === nameOrId,
  );
  if (!match) {
    throw new Error(`VM "${nameOrId}" not found`);
  }
  return api<VM>(`/vms/${match.id}`);
}
