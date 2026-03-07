import type { FastifyInstance } from "fastify";
import { findVMById, checkAccess } from "../db/client.js";
import { execInVM } from "../services/vsock-ssh.js";

interface ClaudeSession {
  id: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function registerClaudeRoutes(app: FastifyInstance) {
  app.get("/vms/:id/claude/sessions", async (request, reply) => {
    const { id } = request.params as { id: string };

    const role = checkAccess(id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    const vm = findVMById(id);
    if (!vm || !vm.vm_ip) {
      return reply.status(404).send({ error: "VM not found" });
    }

    try {
      const output = await execInVM(vm.vm_ip, [
        "bash",
        "-c",
        `find /home/dev/.claude/projects -name '*.json' -path '*/sessions/*' 2>/dev/null | while read f; do echo "---FILE:$f"; cat "$f" 2>/dev/null; done`,
      ]);

      const sessions: ClaudeSession[] = [];
      const parts = output.split("---FILE:").filter(Boolean);

      for (const part of parts) {
        const newlineIdx = part.indexOf("\n");
        if (newlineIdx === -1) continue;
        const filePath = part.substring(0, newlineIdx).trim();
        const jsonStr = part.substring(newlineIdx + 1).trim();

        try {
          const data = JSON.parse(jsonStr);
          const sessionId =
            filePath.split("/").pop()?.replace(".json", "") || "";
          sessions.push({
            id: sessionId,
            title: data.title || data.name || null,
            createdAt: data.createdAt || data.created_at || null,
            updatedAt: data.updatedAt || data.updated_at || null,
          });
        } catch {
          // Skip unparseable session files
        }
      }

      sessions.sort((a, b) => {
        const dateA = a.updatedAt || a.createdAt || "";
        const dateB = b.updatedAt || b.createdAt || "";
        return dateB.localeCompare(dateA);
      });

      return { sessions };
    } catch {
      return { sessions: [] };
    }
  });
}
