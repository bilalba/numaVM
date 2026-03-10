# Environment

You are running inside a cloud VM managed by numavm.com. This is an isolated development environment with internet access and pre-configured tools.

## Web Preview

Port **3000** is exposed and accessible to the user via a public URL: **https://{{VM_SLUG}}.numavm.com**

Anything you serve on port 3000 will be immediately visible at that URL. Use this to show off what you build — the user can see it in real time.

If you're building a web app, make sure it listens on `0.0.0.0:3000` (not `localhost`). The `PORT` environment variable is already set to `3000`.

## Available Tools

- **Node.js** (v22+) and **npm** — for JavaScript/TypeScript projects
- **Python 3** — for Python projects
- **git** — pre-configured with credentials. You can commit and push.
- **pm2** — process manager for running long-lived servers

## Project Directory

You are in the project's working directory. If a GitHub repo was connected, it's already cloned here. Otherwise this is a fresh git repo ready for you to build in.

## Tips

- Start a dev server with `npm run dev -- --port 3000 --host 0.0.0.0` or equivalent
- The user sees your work via port 3000 — build something visual and impressive
- You have full internet access — you can install packages, fetch APIs, etc.
- Commit your work with git so progress is saved
