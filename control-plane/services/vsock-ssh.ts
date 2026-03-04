import { spawn, type ChildProcess } from "node:child_process";
import * as pty from "node-pty";
import { getInternalSshKeyPath } from "./firecracker.js";

/**
 * SSH exec layer for Firecracker VMs.
 *
 * Connects via TCP SSH to the VM's bridge IP (172.16.0.x).
 * The internal SSH keypair authenticates the control plane.
 */

/** Common SSH options for VM connections */
function sshOpts(vmIp: string): string[] {
  const keyPath = getInternalSshKeyPath();
  return [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=5",
    "-i", keyPath,
  ];
}

/**
 * Run a command in the VM and return stdout.
 */
export async function execInVM(
  vmIp: string,
  cmd: string[],
  options?: { user?: string; timeoutMs?: number },
): Promise<string> {
  const user = options?.user || "dev";
  const timeoutMs = options?.timeoutMs || 10000;

  return new Promise((resolve, reject) => {
    const args = [
      ...sshOpts(vmIp),
      `${user}@${vmIp}`,
      "--",
      ...cmd,
    ];

    const proc = spawn("ssh", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve(stdout); // Return what we got so far
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.length > 0) {
        resolve(stdout);
      } else {
        reject(new Error(`SSH exec failed (code ${code}): ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Spawn an interactive PTY session over SSH to the VM.
 * Returns a node-pty IPty handle compatible with the terminal handler.
 */
export function spawnPtyOverVsock(
  vmIp: string,
  remoteCmd: string,
  cols: number,
  rows: number,
): pty.IPty {
  const keyPath = getInternalSshKeyPath();

  const shell = pty.spawn("ssh", [
    "-tt",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-i", keyPath,
    `dev@${vmIp}`,
    "--",
    remoteCmd,
  ], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: "/",
    env: process.env as Record<string, string>,
  });

  return shell;
}

/**
 * Spawn a long-running process with stdio pipes over SSH to the VM.
 * Returns stdin/stdout/stderr streams and a kill function.
 */
export function spawnProcessOverVsock(
  vmIp: string,
  remoteCmd: string,
  options?: { user?: string },
): {
  process: ChildProcess;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill: (signal?: NodeJS.Signals) => void;
} {
  const user = options?.user || "dev";

  const proc = spawn("ssh", [
    ...sshOpts(vmIp),
    `${user}@${vmIp}`,
    "--",
    remoteCmd,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    process: proc,
    stdin: proc.stdin!,
    stdout: proc.stdout!,
    stderr: proc.stderr!,
    kill: (signal?: NodeJS.Signals) => {
      if (!proc.killed) proc.kill(signal || "SIGTERM");
    },
  };
}
