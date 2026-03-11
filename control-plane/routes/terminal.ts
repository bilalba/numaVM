import type { FastifyInstance } from "fastify";
import { getDatabase, getVMEngine } from "../adapters/providers.js";
import { createTerminal } from "../terminal/pty-handler.js";
import { ensureVMRunning, QuotaExceededError } from "../services/wake.js";

export interface TmuxSession {
  name: string;
  windows: number;
  created: number;
  attached: boolean;
}

export function registerTerminalRoutes(app: FastifyInstance) {
  // WebSocket terminal — now accepts ?session=<name> query param
  app.get(
    "/vms/:id/terminal",
    { websocket: true },
    async (socket, request) => {
      const { id } = request.params as { id: string };

      const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
      if (!vm || !vm.vm_ip) {
        socket.close(4004, "VM not found");
        return;
      }

      const role = getDatabase().checkAccess(vm.id, request.userId);
      if (!role) {
        socket.close(4003, "No access to this VM");
        return;
      }

      // Auto-wake snapshotted VMs before opening terminal
      try {
        await ensureVMRunning(vm.id);
      } catch (err: any) {
        if (err instanceof QuotaExceededError) {
          socket.close(4008, "RAM quota exceeded");
        } else {
          request.log.error({ err, vmId: id }, "Failed to wake VM for terminal");
          socket.close(4005, "VM is not running");
        }
        return;
      }

      try {
        const status = await getVMEngine().inspectVM(vm.id);
        if (!status.running) {
          socket.close(4005, "VM is not running");
          return;
        }
      } catch {
        socket.close(4005, "VM not available");
        return;
      }

      const query = request.query as {
        cols?: string;
        rows?: string;
        session?: string;
      };
      const cols = query.cols ? parseInt(query.cols, 10) : 80;
      const rows = query.rows ? parseInt(query.rows, 10) : 24;
      const sessionName = query.session || "main";

      createTerminal({
        ws: socket,
        vmId: vm.id,
        cols: isNaN(cols) ? 80 : cols,
        rows: isNaN(rows) ? 24 : rows,
        sessionName,
      });
    }
  );

  // List tmux sessions inside the VM
  app.get("/vms/:id/terminal/sessions", async (request, reply) => {
    const { id } = request.params as { id: string };

    const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
    if (!vm || !vm.vm_ip) {
      return reply.status(404).send({ error: "VM not found" });
    }

    const role = getDatabase().checkAccess(vm.id, request.userId);
    if (!role) {
      return reply.status(403).send({ error: "No access to this VM" });
    }

    try {
      const output = await getVMEngine().exec(vm.id, [
        "bash", "-c",
        "tmux list-sessions -F '#{session_name}:#{session_windows}:#{session_created}:#{session_attached}' 2>/dev/null || true",
      ]);

      const sessions: TmuxSession[] = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, windows, created, attached] = line.split(":");
          return {
            name,
            windows: parseInt(windows, 10) || 1,
            created: parseInt(created, 10) || 0,
            attached: attached === "1",
          };
        });

      return { sessions };
    } catch {
      return { sessions: [] };
    }
  });

  // Kill a tmux session
  app.delete(
    "/vms/:id/terminal/sessions/:name",
    async (request, reply) => {
      const { id, name } = request.params as { id: string; name: string };

      const vm = getDatabase().findVMById(id) || getDatabase().findVMByName(id);
      if (!vm || !vm.vm_ip) {
        return reply.status(404).send({ error: "VM not found" });
      }

      const role = getDatabase().checkAccess(vm.id, request.userId);
      if (!role) {
        return reply
          .status(403)
          .send({ error: "No access to this VM" });
      }

      // Validate session name to prevent injection
      if (!/^[\w-]+$/.test(name)) {
        return reply
          .status(400)
          .send({ error: "Invalid session name" });
      }

      try {
        await getVMEngine().exec(vm.id, [
          "bash", "-c",
          `tmux kill-session -t ${name} 2>/dev/null || true`,
        ]);
        return { ok: true };
      } catch {
        return reply
          .status(500)
          .send({ error: "Failed to kill terminal session" });
      }
    }
  );
}
