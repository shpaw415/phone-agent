/** Isolated regressions: no production config, data, providers, or CLI tasks. */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";

for (const frozen of [false, true]) test(`signed hooks and one-use media starts fail closed (${frozen ? "frozen payload" : "checkout"})`, async () => {
  const home = mkdtempSync("/tmp/opencode/phone-agent-auth-");
  const id = "phone-agent-auth-test";
  const configDir = join(home, ".config/open-bot");
  const dataDir = join(home, ".open-bot/pages-data", id);
  const fakeBin = join(home, "bin");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(fakeBin);
  const pageToken = "synthetic-dashboard-token";
  const base = `https://example.invalid/hooks/test-user/${id}`;
  const key = "synthetic-signing-secret";
  let modelRequests = 0;
  const stub = Bun.serve({ port: 0, fetch() {
    modelRequests++;
    return Response.json({ error: "offline test stub" }, { status: 503 });
  } });
  const reserve = Bun.serve({ port: 0, fetch: () => new Response("unused") });
  const port = reserve.port!;
  reserve.stop(true);
  const local = `http://127.0.0.1:${port}`;
  const settings: Record<string, string> = {
    public_base: base, phone_provider: "twilio", twilio_auth_token: key,
    signalwire_signing_key: key, twilio_account_sid: "ACsynthetic",
    signalwire_project: "ACsynthetic", xai_api_key: "synthetic-xai-key",
    gateway_base: `http://127.0.0.1:${stub.port}`, twilio_verify: "false", signalwire_verify: "false",
  };
  const saveConfig = () => writeFileSync(join(configDir, `plugin-${id}.json`), JSON.stringify({ settings }));
  saveConfig();
  let serverPath = join(import.meta.dir, "../server/server.ts");
  const uiPath = join(home, "ui.html");
  if (frozen) {
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../server/index.html")], target: "browser", compile: true } as never);
    const html = built.outputs.find((o) => o.path.endsWith(".html"));
    if (!html) throw new Error("frozen UI build failed");
    writeFileSync(uiPath, await html.text());
    const payload = join(home, "payload"); mkdirSync(payload);
    const target = join(payload, "ob-plugin-phone-agent-server.ts");
    copyFileSync(serverPath, target); serverPath = target;
  }
  // Empty PATH prevents notification/worker helpers touching this desktop.
  const child = Bun.spawn([process.execPath, serverPath], {
    env: { ...process.env, HOME: home, PATH: fakeBin, OPEN_BOT_PLUGIN_ID: id,
      OPEN_BOT_PAGE_PORT: String(port), OPEN_BOT_PAGE_TOKEN: pageToken, OPEN_BOT_PAGE_UI: frozen ? uiPath : "" },
    stdout: "pipe", stderr: "pipe",
  });
  const sockets: WebSocket[] = [];
  const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
  const api = (path: string) => fetch(local + path, { headers: { "x-open-bot-page-token": pageToken } });
  const params = (sid: string) => ({ CallSid: sid, AccountSid: "ACsynthetic", From: "+12025550101", To: "+12025550102" });
  async function hook(path: string, body: Record<string, string>, signed = false, signingKey = key) {
    const full = base + path;
    const data = Object.keys(body).sort().reduce((a, k) => a + k + body[k], full);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (signed) headers[path.startsWith("/signalwire/") ? "x-signalwire-signature" : "x-twilio-signature"] =
      createHmac("sha1", signingKey).update(data).digest("base64");
    return fetch(local + path, { method: "POST", headers, body: new URLSearchParams(body) });
  }
  async function socket(query = "") {
    const ws = new WebSocket(local.replace("http", "ws") + "/media" + query);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("upgrade rejected"));
    });
    return ws;
  }
  function start(ws: WebSocket, sid: string, token?: string, extra: Record<string, string> = {}) {
    ws.send(JSON.stringify({ event: "start", start: { callSid: sid, streamSid: "MSsynthetic",
      customParameters: { callSid: sid, ...(token ? { t: token } : {}), ...extra } } }));
  }
  async function deniedStart(sid: string, token?: string) {
    const before = modelRequests;
    const ws = await socket();
    const closed = new Promise<number>((r) => ws.onclose = (ev) => r(ev.code));
    start(ws, sid, token);
    expect(await closed).toBe(1008);
    await wait();
    expect(modelRequests).toBe(before);
  }
  async function issue(provider: string, sid: string, outbound = false) {
    const res = await hook(`/${provider}/${outbound ? "outbound?mission=synthetic-mission" : "voice"}`, params(sid), true);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toMatch(/<Stream url="[^"]+"><Parameter/);
    expect(xml).toContain("</Stream></Connect>");
    const token = xml.match(/<Parameter name="t" value="([a-f0-9]{64})"\/>/)?.[1];
    expect(token).toBeDefined();
    return token!;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(local + "/healthz")).ok) { ready = true; break; } } catch {}
      await wait(20);
    }
    if (!ready) throw new Error("server failed: " + await new Response(child.stderr).text());
    for (const provider of ["twilio", "signalwire"]) {
      settings.twilio_verify = "false"; settings.signalwire_verify = "false";
      settings.phone_provider = provider; saveConfig();
      for (const legacy of [true, false]) {
        if (!legacy) { delete settings.twilio_verify; delete settings.signalwire_verify; saveConfig(); }
        for (const endpoint of ["voice", "outbound", "status"]) {
          expect((await hook(`/${provider}/${endpoint}`, params("CAforged"))).status).toBe(403);
          expect((await hook(`/${provider}/${endpoint}`, params("CAforged"), true, "wrong-key")).status).toBe(403);
        }
      }
      expect((await fetch(local + `/${provider}/voice`)).status).toBe(405);
      expect((await hook(`/${provider}/voice`, params("../../unsafe"), true)).status).toBe(400);
      expect((await hook(`/${provider === "twilio" ? "signalwire" : "twilio"}/voice`, params("CAwrongprovider"), true)).status).toBe(403);
      await deniedStart("CAforged");
      const sid = provider + "_incoming";
      const token = await issue(provider, sid);
      expect((await fetch(local + `/media?call=${sid}&t=wrong`)).status).toBe(401);
      await deniedStart(provider + "_different_call", token);
      const before = readFileSync(join(dataDir, `call-${sid}.json`), "utf8");
      await deniedStart(sid); // knowing a genuine call SID is not authentication
      await deniedStart(sid, "bad-token");
      expect(readFileSync(join(dataDir, `call-${sid}.json`), "utf8")).toBe(before);
      const ws = await socket();
      const count = modelRequests;
      ws.send(JSON.stringify({ event: "media", media: { payload: "AAAA" } }));
      await wait(); expect(modelRequests).toBe(count);
      start(ws, sid, token, { dir: "out", mission: "attacker-controlled" });
      await wait(); expect(modelRequests).toBe(count + 1);
      const record = JSON.parse(readFileSync(join(dataDir, `call-${sid}.json`), "utf8"));
      expect(record.direction).toBe("in");
      expect(record.missionId).toBeUndefined();
      await deniedStart(sid, token); // duplicate/replay cannot hijack or close live call
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close(); await wait();
      await deniedStart(sid, token); // still single-use after disconnect

      const outSid = provider + "_outgoing";
      const outToken = await issue(provider, outSid, true);
      const out = await socket(`?call=${outSid}&t=${outToken}`);
      const outCount = modelRequests;
      await wait(); expect(modelRequests).toBe(outCount); // URL alone creates nothing
      start(out, outSid); // compatibility: token from upgrade query
      await wait(); expect(modelRequests).toBe(outCount + 1);
      const outRecord = JSON.parse(readFileSync(join(dataDir, `call-${outSid}.json`), "utf8"));
      expect(outRecord.direction).toBe("out");
      expect(outRecord.missionId).toBe("synthetic-mission");
      out.close(); await wait();
      const doneSid = provider + "_ended";
      const doneToken = await issue(provider, doneSid);
      expect((await hook(`/${provider}/status`, { ...params(doneSid), CallStatus: "completed" }, true)).status).toBe(200);
      await deniedStart(doneSid, doneToken);
    }
    expect((await fetch(local + "/api/status")).status).toBe(401);
    for (const path of ["/api/calls", "/api/missions", "/missions/api/calls", "/settings/api/status", "/api/missions/place", "/api/hangup", "/api/whisper"])
      expect((await fetch(local + path, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await api("/api/status")).status).toBe(200);
    delete settings.signalwire_signing_key; saveConfig();
    expect((await hook("/signalwire/voice", params("CAnokey"), true)).status).toBe(403);
    expect(readdirSync(dataDir).some((f) => /forged|unknown|unsafe/.test(f))).toBe(false);
    expect(existsSync(join(dataDir, "missions.json"))).toBe(false);
    console.log("PASS: both providers; legacy false; missing/bad signatures; nested Stream ticket; queryless/query starts; replay/duplicate; socket isolation; terminal revocation; protected APIs; no real services");
  } finally {
    for (const ws of sockets) try { ws.close(); } catch {}
    child.kill(); await child.exited;
    stub.stop(true);
    if (!home.startsWith("/tmp/opencode/phone-agent-auth-")) throw new Error("unsafe cleanup target");
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
