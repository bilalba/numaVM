#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setApiUrlOverride } from "./config.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerEnvsCommands } from "./commands/envs.js";
import { registerSshCommand } from "./commands/ssh.js";
import { registerStatusCommand } from "./commands/status.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = "0.1.0";
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
  version = pkg.version;
} catch {}

const program = new Command();
program
  .name("numavm")
  .description("Remote Agent Workbench CLI")
  .version(version)
  .option("--api-url <url>", "Override API base URL")
  .option("--json", "Output as JSON instead of table")
  .option("--verbose", "Verbose output")
  .hook("preAction", () => {
    const opts = program.opts();
    if (opts.apiUrl) {
      setApiUrlOverride(opts.apiUrl);
    }
  });

registerAuthCommands(program);
registerEnvsCommands(program);
registerSshCommand(program);
registerStatusCommand(program);

program.parse();
