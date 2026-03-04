import { Command } from "commander";
import { spawn } from "node:child_process";
import { api } from "../client.js";
import { getApiUrl } from "../config.js";
import { spin } from "../util/spinner.js";

interface Env {
  id: string;
  slug: string;
  name: string;
  status: string;
  ssh_port?: number;
}

export function registerSshCommand(program: Command) {
  program
    .command("ssh <name>")
    .description("SSH into an environment")
    .option("--user <user>", "SSH user", "dev")
    .action(async (name: string, opts: { user: string }) => {
      const spinner = spin("Resolving environment...");

      try {
        const env = await resolveEnv(name);
        spinner.stop();

        if (!env.ssh_port) {
          console.error("Environment does not have an SSH port assigned.");
          process.exit(1);
        }

        if (env.status !== "running") {
          console.error(`Environment is ${env.status}. It must be running to SSH in.`);
          process.exit(1);
        }

        const host = new URL(getApiUrl()).hostname;
        const args = [
          `${opts.user}@${host}`,
          "-p", String(env.ssh_port),
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

async function resolveEnv(nameOrId: string): Promise<Env> {
  try {
    return await api<Env>(`/envs/${nameOrId}`);
  } catch {
    // Fall through
  }
  const envs = await api<Env[]>("/envs");
  const match = envs.find(
    (e) => e.name === nameOrId || e.slug === nameOrId || e.id === nameOrId,
  );
  if (!match) {
    throw new Error(`Environment "${nameOrId}" not found`);
  }
  return api<Env>(`/envs/${match.id}`);
}
