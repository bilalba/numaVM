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
          "new --name <name>": "Create a new VM (shorthand)",
          vms: "List your VMs",
          "vms create --name <name>": "Create a new VM",
          "vms <id>": "Show VM details",
          "vms <id> delete": "Delete a VM",
          "vms <id> start": "Start/wake a VM",
          "vms <id> stop": "Stop/snapshot a VM",
          whoami: "Show your account info",
          version: "Show platform version",
          help: "Show this help message",
        },
        examples: [
          "ssh ssh.numavm.com new --name my-app",
          "ssh ssh.numavm.com vms",
          "ssh ssh.numavm.com vms create --name my-app --repo user/repo --mem 512",
          "ssh ssh.numavm.com vms vm-abc123",
          "ssh vm-abc123@ssh.numavm.com   # shell into VM",
        ],
      });
      break;
  }

  ctx.channel.exit(0);
  ctx.channel.close();
}
