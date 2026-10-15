# phone-agent

open-bot plugin. Edit `open-bot.plugin.json`, then install it locally:

```sh
ob-plugin validate ~/plugins-create/phone-agent
ob-plugin install --path ~/plugins-create/phone-agent
```

Publish when it is ready:

```sh
git init -b main && git add -A && git commit -m "v0.1.0"
gh repo create OWNER/phone-agent --public --source . --push
gh release create v0.1.0 -R OWNER/phone-agent --notes "First release"
ob-plugin publish ~/plugins-create/phone-agent
```

While iterating on a dev tag (set `version` to e.g. `beta-1`), one command does
commit, tag, release, publish, and reinstall:

```sh
ob-plugin publish ~/plugins-create/phone-agent --dev
```

Manifest quick reference:
- skills[]: {name, description, body} — installed into the desktop's OpenViking
- personas[]: {name, instruction} — personalities the thread picker can choose
- cron[]: {name, message, everySeconds | cronExpr} — scheduled jobs
- tools[]: {name, content, exec} — files installed into /usr/local/bin
- files[]: {name, source, exec} — text payloads fetched from the reviewed release tarball and installed next to tools
- Write plugin code in TypeScript, not JavaScript: tool scripts (with a "#!/usr/bin/env bun" shebang), files[] payloads, and dashboard page servers are all .ts files — Bun runs .ts natively, no build step
- configs[]: {key, label, def} — settings shown on the Plugins page
- setup: {commands: [...], uninstall: [...]} — shell commands run as root in the desktop at install and on every desktop start (commands must be idempotent, e.g. "apt-get install -y figlet"); uninstall runs at uninstall; the user sees them in the consent prompt, log at ~/.open-bot/plugin-init/<id>.log
- permissions.vaultRead / vaultCreate: vault key slugs
- dashboard.tabs[]: {id, title, kind: page|iframe, url?, cards?}
- textbox: renderers, commands, buttons, validators, attachments
- opencode: {plugin: [npm...], mcp: {...}, agents: {...new agent defs...}, agentTools: {agent: {glob: bool}}, agentsMd: "standing instructions injected next to AGENTS.md (max 4000 chars, no secrets)"}
- Helper sessions your plugin spawns must be titled with the "worker:" prefix so they stay out of the dashboard thread list.

CONFIG.md (created alongside this file) is the configuration guide the
installing agent reads to configure the plugin with the user — fill it in
whenever the plugin declares configs[] or vault keys.
