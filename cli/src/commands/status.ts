import { Command } from "commander";
import { api } from "../client.js";
import { table } from "../util/table.js";
import { spin } from "../util/spinner.js";

interface HealthResponse {
  status: string;
  envCount?: number;
  runningVMs?: number;
  version?: { commit?: string; branch?: string; timestamp?: string };
}

interface Env {
  name: string;
  slug: string;
  status: string;
  url?: string;
}

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show platform health and environments overview")
    .action(async () => {
      const isJson = program.opts().json;
      const spinner = spin("Fetching status...");

      try {
        const [health, envs] = await Promise.all([
          api<HealthResponse>("/health").catch(() => null),
          api<Env[]>("/envs").catch(() => []),
        ]);
        spinner.stop();

        if (isJson) {
          console.log(JSON.stringify({ health, envs }, null, 2));
          return;
        }

        if (health) {
          console.log("Platform Status");
          console.log(`  Health:  ${health.status}`);
          if (health.envCount !== undefined) console.log(`  Envs:    ${health.envCount}`);
          if (health.runningVMs !== undefined) console.log(`  VMs:     ${health.runningVMs} running`);
          if (health.version?.commit) {
            console.log(`  Version: ${health.version.commit} (${health.version.branch})`);
          }
          console.log();
        }

        if (envs.length === 0) {
          console.log("No environments.");
        } else {
          console.log("Your Environments");
          console.log(
            table(
              ["Name", "Status", "URL"],
              envs.map((e) => [e.name || e.slug, e.status, e.url || ""]),
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
