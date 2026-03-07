import type { ServerChannel } from "ssh2";
import type { SshUser } from "../services/ssh-key-lookup.js";
import { handleVMsCommand } from "./commands/vms.js";
import { handleMetaCommand } from "./commands/meta.js";

/**
 * Parse a command string into args, respecting simple quoting.
 */
function parseArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of command) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Parse --flag and --flag=value from args.
 */
export function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = args[i + 1];
        i++;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

export interface CommandContext {
  user: SshUser;
  channel: ServerChannel;
  args: string[];
  flags: Record<string, string | true>;
}

/**
 * Dispatch an SSH exec command to the appropriate handler.
 * Writes JSON to stdout, errors to stderr, and sets exit code.
 */
export async function dispatchSshCommand(
  command: string,
  user: SshUser,
  channel: ServerChannel,
): Promise<void> {
  const rawArgs = parseArgs(command.trim());
  if (rawArgs.length === 0) {
    writeJson(channel, { error: "No command specified. Run 'help' for usage." });
    channel.exit(1);
    channel.close();
    return;
  }

  const resource = rawArgs[0];
  const restArgs = rawArgs.slice(1);
  const { positional, flags } = parseFlags(restArgs);

  const ctx: CommandContext = { user, channel, args: positional, flags };

  try {
    switch (resource) {
      case "vms":
      case "vm":
      case "envs":
      case "env":
        await handleVMsCommand(ctx);
        break;
      case "new":
        // "new --name xyz" → "vms create --name xyz"
        ctx.args = ["create", ...ctx.args];
        await handleVMsCommand(ctx);
        break;
      case "whoami":
      case "version":
      case "help":
        await handleMetaCommand(resource, ctx);
        break;
      default:
        writeError(channel, `Unknown command: ${resource}. Run 'help' for usage.`);
        channel.exit(1);
        channel.close();
        return;
    }
  } catch (err: any) {
    writeError(channel, `Error: ${err.message}`);
    channel.exit(2);
    channel.close();
  }
}

export function writeJson(channel: ServerChannel, data: any): void {
  channel.write(JSON.stringify(data, null, 2) + "\n");
}

export function writeError(channel: ServerChannel, message: string): void {
  channel.stderr.write(message + "\n");
}
