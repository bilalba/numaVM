import { Command } from "commander";
import { createServer } from "node:http";
import { loadConfig, setToken, clearToken, getToken, getApiUrl } from "../config.js";
import { api } from "../client.js";
import { spin } from "../util/spinner.js";

export function registerAuthCommands(program: Command) {
  const auth = program
    .command("auth")
    .description("Manage authentication");

  auth
    .command("login")
    .description("Open browser to authenticate via GitHub/Google OAuth")
    .action(async () => {
      const config = loadConfig();
      const apiUrl = config.api_url;

      // Start a local server to receive the callback
      const token = await new Promise<string>((resolve, reject) => {
        const server = createServer((req, res) => {
          const url = new URL(req.url!, `http://localhost`);

          if (url.pathname === "/callback") {
            const jwt = url.searchParams.get("token");
            if (jwt) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end("<html><body><h2>Authenticated! You can close this tab.</h2></body></html>");
              server.close();
              resolve(jwt);
            } else {
              res.writeHead(400, { "Content-Type": "text/html" });
              res.end("<html><body><h2>Authentication failed — no token received.</h2></body></html>");
              server.close();
              reject(new Error("No token received in callback"));
            }
          } else {
            res.writeHead(404);
            res.end();
          }
        });

        server.listen(0, "127.0.0.1", async () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            reject(new Error("Failed to start local server"));
            return;
          }

          const port = addr.port;
          const callbackUrl = `http://localhost:${port}/callback`;
          const loginUrl = `${apiUrl}/login?cli_redirect=${encodeURIComponent(callbackUrl)}`;

          console.log(`Opening browser to authenticate...`);
          console.log(`If the browser doesn't open, visit: ${loginUrl}`);

          try {
            const open = (await import("open")).default;
            await open(loginUrl);
          } catch {
            console.log("Could not open browser automatically.");
          }
        });

        // Timeout after 5 minutes
        setTimeout(() => {
          server.close();
          reject(new Error("Authentication timed out after 5 minutes"));
        }, 5 * 60 * 1000);
      });

      setToken(token);
      console.log("Authenticated successfully!");
    });

  auth
    .command("logout")
    .description("Clear stored credentials")
    .action(() => {
      clearToken();
      console.log("Logged out.");
    });

  auth
    .command("whoami")
    .description("Show current user")
    .action(async () => {
      try {
        const user = await api<{ id: string; email: string; name: string }>("/me");
        console.log(`${user.name} <${user.email}>`);
      } catch (err: any) {
        if (err.status === 401) {
          console.error("Not logged in. Run `numavm auth login` first.");
        } else {
          console.error(`Error: ${err.message}`);
        }
        process.exit(1);
      }
    });

  auth
    .command("token")
    .description("Print current API token")
    .action(() => {
      const token = getToken();
      if (!token) {
        console.error("No token stored. Run `numavm auth login` first.");
        process.exit(1);
      }
      console.log(token);
    });
}
