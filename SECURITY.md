# Security

## How CC Agent is meant to run

CC Agent is a self-hosted app that starts Claude Code sessions on your computer, as your user. Keep these facts in mind:

- **A full-access agent can do whatever you can do** on that machine: read and change your files, run programs, use your network. Give full access only to agents you would trust with your terminal.
- **Messaging plugins stay with you, not your agents.** Claude Code's official Discord channel plugin runs a bot with your token; if it is installed on the host, an agent that loaded it would act as that bot. CC Agent therefore switches it off for its agents (it writes `"enabledPlugins": {"discord@claude-plugins-official": false}` to `.claude/settings.local.json` in the agent's workspace and in the git repositories above it) and refuses `/plugin enable` for it from the chat; an agent bound to a repository gets the same switch from a settings file passed to that launch only, so nothing is written into the repository. Other plugins you install are loaded by full-access agents as usual: review them with the same care.
- **Scoped agents** can read and write only the folders you allow, and load only the local MCP servers you tick (an agent you give another member uses only the claude.ai connectors you tick, too). They run in Claude Code's auto mode, so they may decide for themselves to fetch web pages: the domains you list are approved in advance, and the sandbox holds Bash's network access to those domains. They run with Claude Code's sandbox and permission rules, and CC Agent writes their settings itself and refuses grants that would reach its own data. This narrows what an agent can do; it is not a guarantee. Treat an agent that reads untrusted content (web pages, email, outside chats) as able to be talked into things.
- **The server listens on 127.0.0.1 only.** To reach it from other devices, put it behind HTTPS and set `CC_AGENT_PUBLIC_ORIGIN`. Don't expose the port directly.
- **Use Cloudflare Tunnel, or a proxy that behaves like it.** Sign-in rate limits and lockouts are counted per visitor address, which CC Agent reads from the `CF-Connecting-IP` header on connections from this machine, and it refuses `/bridge` requests that carry a forwarding header (Cloudflare's, Tailscale Serve's `Tailscale-User-Login`, `X-Forwarded-For` or `Forwarded`). If you use another reverse proxy, make it **overwrite** `CF-Connecting-IP` with the real client address (never pass through a value the visitor sent) and block `/bridge` from outside, or at least make it add `X-Forwarded-For`. Otherwise a visitor can dodge the sign-in limits by sending made-up addresses, or every visitor counts as one address and one person can lock everyone out.
- **Accounts are the front door.** Change the generated `admin` password on first sign-in, and turn on two-step sign-in or add a passkey. Members cannot create full-access agents.
- **Where your data lives.** Accounts, conversations, attachments, secrets and push keys are in `.local/` inside the project folder (or the folder `CC_AGENT_DATA_DIR` names). The request audit log, with visitor addresses and request paths, is in `server/logs/`, or in `logs/` inside the data folder when `CC_AGENT_DATA_DIR` is set. Each agent's full Claude Code transcript is kept by Claude Code in `~/.claude/projects/`. Keep all three out of backups you share, and never commit them.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's **Report a vulnerability** button (private vulnerability reporting) on this repository, with steps to reproduce and the version you saw it in (Settings, at the bottom of the page).

We will acknowledge the report, work on a fix, and credit you in the release notes unless you prefer otherwise.
