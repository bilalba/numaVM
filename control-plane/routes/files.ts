import type { FastifyInstance } from "fastify";
import { findVMById, checkAccess } from "../db/client.js";
import { execInVM } from "../services/vsock-ssh.js";

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  size: number;
  modified: string;
}

function sanitizePath(raw: string): string {
  // Normalize and strip traversal attempts
  const parts = raw.split("/").filter((p) => p !== ".." && p !== "");
  return "/" + parts.join("/");
}

function parseLsLine(line: string): FileEntry | null {
  // Parse `ls -la --time-style=long-iso` output
  const match = line.match(
    /^([dlcbsp-])([rwxsStT-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/
  );
  if (!match) return null;

  const typeChar = match[1];
  const size = parseInt(match[3], 10);
  const modified = match[4];
  let name = match[5];

  // Skip . and .. entries
  if (name === "." || name === "..") return null;

  let type: FileEntry["type"] = "file";
  if (typeChar === "d") {
    type = "dir";
  } else if (typeChar === "l") {
    type = "symlink";
    const arrowIdx = name.indexOf(" -> ");
    if (arrowIdx !== -1) name = name.substring(0, arrowIdx);
  }

  return { name, type, size, modified };
}

export function registerFileRoutes(app: FastifyInstance) {
  app.get("/vms/:id/files", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string };

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const vm = findVMById(id);
    if (!vm || !vm.vm_ip) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const dirPath = sanitizePath(query.path || "/home/dev");

    try {
      const output = await execInVM(vm.vm_ip, [
        "ls", "-la", "--time-style=long-iso", dirPath,
      ]);

      const lines = output.split("\n").filter(Boolean);
      const entries: FileEntry[] = [];

      for (const line of lines) {
        if (line.startsWith("total ")) continue;
        const entry = parseLsLine(line);
        if (entry) entries.push(entry);
      }

      entries.sort((a, b) => {
        if (a.type === "dir" && b.type !== "dir") return -1;
        if (a.type !== "dir" && b.type === "dir") return 1;
        return a.name.localeCompare(b.name);
      });

      return { path: dirPath, entries };
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to list files: ${err.message}` });
    }
  });

  // Read file content
  app.get("/vms/:id/files/read", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string };

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const vm = findVMById(id);
    if (!vm || !vm.vm_ip) {
      return reply.status(404).send({ error: "VM not found" });
    }

    if (!query.path) {
      return reply.status(400).send({ error: "path query parameter is required" });
    }

    const filePath = sanitizePath(query.path);

    try {
      const sizeOutput = await execInVM(vm.vm_ip, [
        "stat", "--format=%s", filePath,
      ]);
      const size = parseInt(sizeOutput.trim(), 10);
      if (isNaN(size)) {
        return reply.status(404).send({ error: "File not found" });
      }
      if (size > 1_048_576) {
        return reply.status(413).send({ error: "File too large (max 1MB)" });
      }

      const mimeOutput = await execInVM(vm.vm_ip, [
        "file", "--brief", "--mime-type", filePath,
      ]);
      const mimeType = mimeOutput.trim();
      const binary = !mimeType.startsWith("text/") && mimeType !== "application/json" && mimeType !== "application/javascript" && mimeType !== "application/xml";

      if (binary) {
        return { path: filePath, binary: true, mimeType, size, content: null };
      }

      const content = await execInVM(vm.vm_ip, ["cat", filePath]);
      return { path: filePath, binary: false, mimeType, size, content };
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to read file: ${err.message}` });
    }
  });

  // Download file (streams raw content with Content-Disposition)
  app.get("/vms/:id/files/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string };

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const vm = findVMById(id);
    if (!vm || !vm.vm_ip) {
      return reply.status(404).send({ error: "VM not found" });
    }

    if (!query.path) {
      return reply.status(400).send({ error: "path query parameter is required" });
    }

    const filePath = sanitizePath(query.path);
    const fileName = filePath.split("/").pop() || "download";

    try {
      // Check file exists and get size
      const sizeOutput = await execInVM(vm.vm_ip, [
        "stat", "--format=%s", filePath,
      ]);
      const size = parseInt(sizeOutput.trim(), 10);
      if (isNaN(size)) {
        return reply.status(404).send({ error: "File not found" });
      }
      if (size > 50_000_000) {
        return reply.status(413).send({ error: "File too large (max 50MB)" });
      }

      // Get mime type
      const mimeOutput = await execInVM(vm.vm_ip, [
        "file", "--brief", "--mime-type", filePath,
      ]);
      const mimeType = mimeOutput.trim() || "application/octet-stream";

      // Read file content as base64 for binary-safe transfer
      const b64 = await execInVM(vm.vm_ip, ["base64", filePath]);
      const content = Buffer.from(b64.trim(), "base64");

      return reply
        .header("Content-Type", mimeType)
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .header("Content-Length", content.length)
        .send(content);
    } catch (err: any) {
      return reply.status(500).send({ error: `Failed to download file: ${err.message}` });
    }
  });

  // Git log
  app.get("/vms/:id/git/log", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string };

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const vm = findVMById(id);
    if (!vm || !vm.vm_ip) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const limit = Math.min(parseInt(query.limit || "20", 10) || 20, 100);

    try {
      const output = await execInVM(vm.vm_ip, [
        "git", "-C", "/home/dev/repo", "log",
        `--max-count=${limit}`,
        "--format=%H|||%an|||%ae|||%at|||%s",
      ]);

      const commits = output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, author, email, timestamp, ...msgParts] = line.split("|||");
          return {
            hash,
            author,
            email,
            date: new Date(parseInt(timestamp, 10) * 1000).toISOString(),
            message: msgParts.join("|||"),
          };
        });

      return { commits };
    } catch {
      return { commits: [] };
    }
  });
}
