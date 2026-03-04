import { Command } from "commander";
import { api } from "../client.js";
import { table } from "../util/table.js";
import { spin } from "../util/spinner.js";

interface Env {
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

export function registerEnvsCommands(program: Command) {
  const envs = program
    .command("envs")
    .description("Manage environments");

  envs
    .command("list")
    .description("List all environments")
    .action(async () => {
      const isJson = program.opts().json;
      const spinner = spin("Fetching environments...");

      try {
        const list = await api<Env[]>("/envs");
        spinner.stop();

        if (isJson) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }

        if (list.length === 0) {
          console.log("No environments found. Create one with `numavm envs create <name>`.");
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

  envs
    .command("create <name>")
    .description("Create a new environment")
    .option("--repo <owner/repo>", "Use existing GitHub repo")
    .action(async (name: string, opts: { repo?: string }) => {
      const isJson = program.opts().json;
      const spinner = spin(`Creating environment "${name}"...`);

      try {
        const body: Record<string, string> = { name };
        if (opts.repo) body.gh_repo = opts.repo;

        const env = await api<Env>("/envs", {
          method: "POST",
          body: JSON.stringify(body),
        });
        spinner.stop();

        if (isJson) {
          console.log(JSON.stringify(env, null, 2));
          return;
        }

        console.log(`Environment "${name}" created!`);
        if (env.url) console.log(`  URL:  ${env.url}`);
        if (env.repo_url) console.log(`  Repo: ${env.repo_url}`);
        if (env.ssh_port) console.log(`  SSH:  ssh dev@${new URL(env.url || "").hostname} -p ${env.ssh_port}`);
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  envs
    .command("info <name>")
    .description("Show environment details")
    .action(async (name: string) => {
      const isJson = program.opts().json;
      const spinner = spin("Fetching environment...");

      try {
        const env = await resolveEnv(name);
        spinner.stop();

        if (isJson) {
          console.log(JSON.stringify(env, null, 2));
          return;
        }

        console.log(`Name:    ${env.name || env.slug}`);
        console.log(`Status:  ${env.status}`);
        if (env.url) console.log(`URL:     ${env.url}`);
        if (env.repo_url) console.log(`Repo:    ${env.repo_url}`);
        if (env.ssh_port) console.log(`SSH:     port ${env.ssh_port}`);
        if (env.vm_ip) console.log(`VM IP:   ${env.vm_ip}`);
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  envs
    .command("destroy <name>")
    .description("Destroy an environment")
    .option("--yes", "Skip confirmation")
    .action(async (name: string, opts: { yes?: boolean }) => {
      const env = await resolveEnv(name);

      if (!opts.yes) {
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Destroy environment "${env.name || env.slug}"? This cannot be undone. [y/N] `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== "y") {
          console.log("Aborted.");
          return;
        }
      }

      const spinner = spin("Destroying environment...");
      try {
        await api(`/envs/${env.id}`, { method: "DELETE" });
        spinner.stop();
        console.log(`Environment "${env.name || env.slug}" destroyed.`);
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  envs
    .command("pause <name>")
    .description("Snapshot and pause an environment")
    .action(async (name: string) => {
      const env = await resolveEnv(name);
      const spinner = spin("Pausing environment...");

      try {
        await api(`/envs/${env.id}/pause`, { method: "POST" });
        spinner.stop();
        console.log(`Environment "${env.name || env.slug}" paused.`);
      } catch (err: any) {
        spinner.stop();
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}

async function resolveEnv(nameOrId: string): Promise<Env> {
  // Try direct ID lookup first
  try {
    return await api<Env>(`/envs/${nameOrId}`);
  } catch {
    // Fall through to list-based lookup
  }

  // Search by name/slug in the list
  const envs = await api<Env[]>("/envs");
  const match = envs.find(
    (e) => e.name === nameOrId || e.slug === nameOrId || e.id === nameOrId,
  );
  if (!match) {
    throw new Error(`Environment "${nameOrId}" not found`);
  }
  return api<Env>(`/envs/${match.id}`);
}
