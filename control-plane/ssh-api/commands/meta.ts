import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandContext } from "../dispatcher.js";
import { writeJson } from "../dispatcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function handleMetaCommand(command: string, ctx: CommandContext): Promise<void> {
  switch (command) {
    case "whoami":
      writeJson(ctx.channel, {
        id: ctx.user.userId,
        email: ctx.user.email,
        name: ctx.user.name,
        github_username: ctx.user.githubUsername,
        plan: ctx.user.plan,
      });
      break;

    case "version": {
      let version: any = { version: "dev" };
      try {
        const raw = readFileSync(join(__dirname, "..", "..", "..", "version.json"), "utf-8");
        version = JSON.parse(raw);
      } catch {
        // dev mode — no version.json
      }
      writeJson(ctx.channel, version);
      break;
    }

    case "help":
      writeJson(ctx.channel, {
        commands: {
          "new --name <name>": "Create a new environment (shorthand)",
          envs: "List your environments",
          "envs create --name <name>": "Create a new environment",
          "envs <id>": "Show environment details",
          "envs <id> delete": "Delete an environment",
          "envs <id> start": "Start/wake an environment",
          "envs <id> stop": "Stop/snapshot an environment",
          whoami: "Show your account info",
          version: "Show platform version",
          help: "Show this help message",
        },
        examples: [
          "ssh ssh.numavm.com new --name my-app",
          "ssh ssh.numavm.com envs",
          "ssh ssh.numavm.com envs create --name my-app --repo user/repo --mem 512",
          "ssh ssh.numavm.com envs env-abc123",
          "ssh env-abc123@ssh.numavm.com   # shell into env",
        ],
      });
      break;
  }

  ctx.channel.exit(0);
  ctx.channel.close();
}
