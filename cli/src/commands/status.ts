import { Command } from "commander";
import { api } from "../client.js";
import { table } from "../util/table.js";
import { spin } from "../util/spinner.js";

interface HealthResponse {
  status: string;
  vmCount?: number;
  runningVMs?: number;
  version?: { commit?: string; branch?: string; timestamp?: string };
}

interface VM {
  name: string;
  slug: string;
  status: string;
  url?: string;
}

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show platform health and VMs overview")
    .action(async () => {
      const isJson = program.opts().json;
      const spinner = spin("Fetching status...");

      try {
        const [health, vms] = await Promise.all([
          api<HealthResponse>("/health").catch(() => null),
          api<VM[]>("/vms").catch(() => []),
        ]);
        spinner.stop();

        if (isJson) {
          console.log(JSON.stringify({ health, vms }, null, 2));
          return;
        }

        if (health) {
          console.log("Platform Status");
          console.log(`  Health:  ${health.status}`);
          if (health.vmCount !== undefined) console.log(`  VMs:     ${health.vmCount}`);
          if (health.runningVMs !== undefined) console.log(`  Running: ${health.runningVMs}`);
          if (health.version?.commit) {
            console.log(`  Version: ${health.version.commit} (${health.version.branch})`);
          }
          console.log();
        }

        if (vms.length === 0) {
          console.log("No VMs.");
        } else {
          console.log("Your VMs");
          console.log(
            table(
              ["Name", "Status", "URL"],
              vms.map((e) => [e.name || e.slug, e.status, e.url || ""]),
            ),
          );
        }
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
