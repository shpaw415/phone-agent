#!/usr/bin/env bun
/**
 * phone-agent — dashboard page server (Bun). One process, three jobs:
 *
 *  1. Dashboard tab (proxied under /api/pages/phone-agent/):
 *     GET /            → the app (live calls + transcript + whisper mic + history,
 *                        missions, settings — in-app nav via #calls #missions #settings)
 *     /index.html, /missions, /settings → same app (legacy paths)
 *     APIs: api/status, api/calls, api/calls?full=<sid>, api/missions,
 *           api/missions/place (POST), api/hangup (POST), api/whisper (POST)
 *     UI: served from the control-plane bundle (OPEN_BOT_PAGE_UI) or, in a
 *     local checkout, imported live from ./index.html (see "page UI" below).
 *
 *  2. Telephony webhooks (public endpoint /hooks/phone-agent/…):
 *     POST /twilio/voice | /signalwire/voice    → incoming call TwiML/cXML (Connect Stream or polite decline)
 *     POST /twilio/outbound | /signalwire/outbound → outbound call answer TwiML/cXML (Connect Stream)
 *     POST /twilio/status | /signalwire/status  → status callbacks, finalizes calls + mission reports
 *
 *  3. Media bridge: WebSocket /media — provider Media Streams (mulaw 8 kHz) bridged
 *     to the xAI realtime API (pcm16 24 kHz). Tools: delegate_openbot,
 *     start_thread, hang_up_call. Whisper from the dashboard is injected live.
 *
 * Config comes from ~/.config/open-bot/plugin-phone-agent.json — never edit by hand.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";

// Production: the control plane sets OPEN_BOT_PLUGIN_ID=phone-agent.
// The preview runtime derives it from the file name ("server") — ignore that.
const RAW_ID = process.env.OPEN_BOT_PLUGIN_ID || "";
const PLUGIN_ID = RAW_ID && RAW_ID !== "server" ? RAW_ID : "phone-agent";
const PORT = Number(process.env.OPEN_BOT_PAGE_PORT ?? 4761);
const DATA_DIR = join(homedir(), ".open-bot", "pages-data", PLUGIN_ID);
const CFG_FILE = join(homedir(), ".config", "open-bot", `plugin-${PLUGIN_ID}.json`);
const MAX_CALL_SEC = 30 * 60;

type Cfg = { settings?: Record<string, string>; vault?: Record<string, string> };

function loadConfig(): Cfg {
  try {
    return JSON.parse(readFileSync(CFG_FILE, "utf8")) as Cfg;
  } catch {
    return {};
  }
}
const cleanKey = (v: unknown): string => String(v ?? "").replace(/\s+/g, "");

/** The shared Config-page key (vault slug "xai") can be stored as a plain string
 *  or as a {accountId, apiKey, baseUrl} object — extract the usable key either way. */
function keyFromVaultEntry(entry: unknown): string {
  if (entry && typeof entry === "object") {
    const o = entry as Record<string, unknown>;
    return cleanKey(o.apiKey ?? o.key ?? o.token ?? "");
  }
  const s = cleanKey(entry);
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      return cleanKey(o.apiKey ?? o.key ?? o.token ?? "");
    } catch {
      return "";
    }
  }
  return s;
}

/** The Space setting accepts the bare name, the full domain, or a URL. */
function swSpaceOf(set: Record<string, string>): string {
  return (set.signalwire_space || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\.signalwire\.com.*$/i, "")
    .replace(/\/+$/, "");
}

/** Telephony (call transport) config for the active phone_provider.
 *  SignalWire's Compatibility API mirrors Twilio's REST paths and webhooks,
 *  so both providers share the same transport layer. */
function telConf(set: Record<string, string>, val: Record<string, string>) {
  const provider = (set.phone_provider || "twilio").trim() === "signalwire" ? "signalwire" : "twilio";
  if (provider === "signalwire") {
    const space = swSpaceOf(set);
    const base = (set.signalwire_base || (space ? `https://${space}.signalwire.com/api/laml` : ""))
      .trim()
      .replace(/\/+$/, "");
    return {
      provider,
      sid: cleanKey(set.signalwire_project) || cleanKey(val["phone-agent-signalwire-project"]),
      token: cleanKey(set.signalwire_token) || cleanKey(val["phone-agent-signalwire-token"]),
      phone: (cleanKey(set.signalwire_phone) || cleanKey(val["phone-agent-signalwire-phone"])).replace(/\s+/g, ""),
      base,
      signingKey: cleanKey(set.signalwire_signing_key) || cleanKey(val["phone-agent-signalwire-signing-key"]),
      space,
    };
  }
  return {
    provider,
    sid: cleanKey(set.twilio_account_sid) || cleanKey(val["phone-agent-twilio-sid"]),
    token: cleanKey(set.twilio_auth_token) || cleanKey(val["phone-agent-twilio-token"]),
    phone: (cleanKey(set.twilio_phone) || cleanKey(val["phone-agent-twilio-phone"])).replace(/\s+/g, ""),
    base: "",
    signingKey: "",
    space: "",
  };
}

function conf() {
  const { settings: s, vault: v } = loadConfig();
  const set = s ?? {};
  const val = v ?? {};
  const twilio = telConf(set, val);
  const swSpace = swSpaceOf(set);
  const swBase = (set.signalwire_base || (swSpace ? `https://${swSpace}.signalwire.com/api/laml` : ""))
    .trim()
    .replace(/\/+$/, "");
  const tel =
    twilio.provider === "signalwire"
      ? twilio
      : { ...twilio, base: (set.twilio_base || "https://api.twilio.com").trim().replace(/\/+$/, "") };
  const xaiKey =
    cleanKey(set.xai_api_key) || cleanKey(val["xai-api-key"]) || keyFromVaultEntry(val["xai"]);
  return {
    model: (set.model || "grok-voice-latest").trim(),
    voice: (set.voice || "eve").trim(),
    instructions: (set.instructions || "").trim(),
    capabilities: (set.capabilities || "").trim(),
    delegate_agent: (set.delegate_agent || "").trim(),
    delegate_timeout: Math.min(600, Math.max(30, Number(set.delegate_timeout ?? 240) || 240)),
    publicBase: (set.public_base || "").trim().replace(/\/+$/, ""),
    gatewayBase: (set.gateway_base || "").trim().replace(/\/+$/, ""),
    autoAnswer: (set.auto_answer ?? "true") === "true",
    verify: (set.twilio_verify ?? "false") === "true",
    swVerify: (set.signalwire_verify ?? "false") === "true",
    phoneProvider: tel.provider,
    tel,
    swSpace,
    swBase,
    xaiKey,
  };
}

/* ---------------- store ---------------- */

type Turn = { role: "agent" | "caller" | "whisper"; text: string; ts: string };
type CallRec = {
  callSid: string;
  direction: "in" | "out";
  from?: string;
  to?: string;
  status: string; // ringing|in-progress|completed|busy|failed|no-answer|canceled
  missionId?: string;
  startedAt: string;
  endedAt?: string;
  durationSec?: number;
  answered?: boolean;
  error?: string;
  transcript?: Turn[];
};
type Mission = {
  id: string;
  to: string;
  mission: string;
  status: string;
  callSid?: string;
  createdAt: string;
  endedAt?: string;
  report?: string;
};

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, data: unknown) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, file), JSON.stringify(data, null, 1));
  } catch {}
}
const loadCalls = () => readJson<CallRec[]>("calls.json", []);
const saveCalls = (list: CallRec[]) => writeJson("calls.json", list.slice(-500));
const loadMissions = () => readJson<Mission[]>("missions.json", []);
const saveMissions = (list: Mission[]) => writeJson("missions.json", list.slice(-500));
const detailFile = (sid: string) => `call-${sid}.json`;
const loadDetail = (sid: string) => readJson<CallRec | null>(detailFile(sid), null);
const saveDetail = (rec: CallRec) => writeJson(detailFile(rec.callSid), rec);

function upsertSummary(rec: CallRec) {
  const list = loadCalls();
  const i = list.findIndex((c) => c.callSid === rec.callSid);
  const brief: CallRec = { ...rec };
  delete brief.transcript;
  if (i >= 0) list[i] = brief;
  else list.push(brief);
  saveCalls(list);
}

/* ---------------- audio: mulaw 8k <-> pcm16 24k ---------------- */

const ULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  ULAW_DECODE[i] = (u & 0x80 ? 0x84 - t : t - 0x84) as number;
}

function mulawToPcm(b64: string): Int16Array {
  const bin = Buffer.from(b64, "base64");
  const out = new Int16Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = ULAW_DECODE[bin[i]];
  return out;
}

function pcmToMulawB64(pcm: Int16Array): string {
  const BIAS = 0x84;
  const CLIP = 32635;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let x = pcm[i];
    const sign = x < 0 ? 0x80 : 0x00;
    if (sign) x = -x;
    if (x > CLIP) x = CLIP;
    x += BIAS;
    let exponent = 7;
    let expMask = 0x4000;
    while (exponent > 0 && (x & expMask) === 0) {
      exponent--;
      expMask >>= 1;
    }
    const mantissa = (x >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out.toString("base64");
}

/** 8k -> 24k (x3, linear interpolation). */
function upsample3(a: Int16Array): Int16Array {
  const out = new Int16Array(a.length * 3);
  for (let i = 0; i < a.length; i++) {
    const cur = a[i];
    const next = i + 1 < a.length ? a[i + 1] : cur;
    out[i * 3] = cur;
    out[i * 3 + 1] = Math.round((2 * cur + next) / 3);
    out[i * 3 + 2] = Math.round((cur + 2 * next) / 3);
  }
  return out;
}

/** 24k -> 8k (pick middle of each 3-sample group). */
function downsample3(a: Int16Array): Int16Array {
  const n = Math.floor(a.length / 3);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i * 3 + 1];
  return out;
}

function pcmToB64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, 0, pcm.byteLength).toString("base64");
}
function b64ToPcm(b64: string): Int16Array {
  const buf = Buffer.from(b64, "base64");
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/* ---------------- provider REST (Twilio / SignalWire compat) + webhooks ---------------- */

async function telApi(path: string, params: Record<string, string> | null): Promise<{ status: number; json: any }> {
  const c = conf();
  const t = c.tel;
  if (!t.sid || !t.token)
    return { status: 0, json: { message: (t.provider === "signalwire" ? "SignalWire" : "Twilio") + " credentials missing" } };
  const url = `${t.base}/2010-04-01/Accounts/${t.sid}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${t.sid}:${t.token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

function hangupCall(callSid: string): Promise<{ status: number; json: any }> {
  return telApi(`/Calls/${encodeURIComponent(callSid)}.json`, { Status: "completed" });
}

/** Webhook signature check — HMAC-SHA1 over url+sorted params, same scheme for
 *  both providers; header and key differ (Twilio: auth token / X-Twilio-Signature,
 *  SignalWire: project signing key / X-SignalWire-Signature). */
function hookSigned(req: Request, params: Record<string, string>, provider: "twilio" | "signalwire"): boolean {
  const c = conf();
  const sig = req.headers.get(provider === "signalwire" ? "x-signalwire-signature" : "x-twilio-signature") || "";
  const key = provider === "signalwire" ? c.tel.signingKey : c.tel.token;
  if (!sig || !key || !c.publicBase) return false;
  const url = new URL(req.url);
  // Rebuild the URL as the provider saw it: public endpoint + plugin path.
  const idx = url.pathname.indexOf(`/${PLUGIN_ID}/`);
  const pluginPath = idx >= 0 ? url.pathname.slice(idx + PLUGIN_ID.length + 1) : url.pathname;
  const full = c.publicBase + pluginPath + (url.search || "");
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], full);
  const expected = createHmac("sha1", key).update(data).digest("base64");
  return sig === expected;
}

async function formParams(req: Request): Promise<Record<string, string>> {
  try {
    const text = await req.text();
    const out: Record<string, string> = {};
    new URLSearchParams(text).forEach((v, k) => (out[k] = v));
    return out;
  } catch {
    return {};
  }
}

function twiml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

function xmlAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Shared secret for per-call media tokens: a runtime secret that already
 *  exists on every working setup (never leaves the server, never logged). */
function mediaSecret(): string {
  const c = conf();
  return c.xaiKey || c.tel.token || c.tel.signingKey || "";
}

/** Per-call token bound to the stream parameters. The telephony provider just
 *  echoes the wss URL back, so it needs no knowledge of the token — but an
 *  outside party cannot open /media without it (fail closed when no secret). */
function mediaToken(call: string, dir: string, mission: string): string {
  const s = mediaSecret();
  if (!s) return "";
  return createHmac("sha256", s).update(`${call}:${dir}:${mission}`).digest("hex").slice(0, 32);
}

function streamUrl(extra: Record<string, string>): string {
  const c = conf();
  const t = mediaToken(extra.call || "", extra.dir || "", extra.mission || "");
  if (t) extra = { ...extra, t };
  const q = new URLSearchParams(extra).toString();
  return c.publicBase.replace(/^https/i, "wss") + "/media?" + q;
}

/* ---------------- worker + CLI spawn ---------------- */

function workerBin(): string[] {
  const bin = `/usr/local/bin/ob-plugin-${PLUGIN_ID}-mission-worker`;
  const local = join(import.meta.dir, "..", "worker", "worker.ts");
  return existsSync(bin) ? [bin] : ["bun", local];
}

function spawnWorker(args: string[]) {
  const cmd = workerBin();
  try {
    Bun.spawn(["setsid", ...cmd, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    try {
      Bun.spawn([...cmd, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } catch {}
  }
}

function spawnDetachedThread(topic: string) {
  const id = crypto.randomUUID().slice(0, 8);
  writeJson(`thread-task-${id}.json`, { topic });
  spawnWorker(["thread", id]);
}

async function runCli(name: "call" | "hangup", args: string[]): Promise<any> {
  const bin = `/usr/local/bin/ob-plugin-${PLUGIN_ID}-${name}`;
  const local = join(import.meta.dir, "..", "tools", `${name}.ts`);
  const cmd = existsSync(bin) ? [bin, ...args] : ["bun", local, ...args];
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    try {
      return JSON.parse(out);
    } catch {
      return { ok: false, error: "cli_output", hint: out.slice(0, 300) };
    }
  } catch (e) {
    return { ok: false, error: "spawn", hint: String(e).slice(0, 200) };
  }
}

/* ---------------- media bridge (Twilio <-> xAI realtime) ---------------- */

type Bridge = {
  twilio: any; // Bun ServerWebSocket
  streamSid: string;
  callSid: string;
  dir: "in" | "out";
  missionId?: string;
  xai?: WebSocket;
  xaiReady: boolean;
  xaiTries: number;
  queuedIn: string[]; // b64 mulaw chunks buffered until xAI is ready
  rec: CallRec;
  agentBuf: string;
  lastTurnAt: number;
  saveDirty: boolean;
  delegations: Map<string, { id: string; tries: number }>;
  hangupAt: number;
  startedAt: number;
  timer: ReturnType<typeof setInterval> | null;
  /** Queryless upgrade not yet identified by a "start" event: no session, no records. */
  inert?: boolean;
};

const bridges = new Map<string, Bridge>(); // by callSid

function missionText(missionId?: string): string {
  if (!missionId) return "";
  const m = loadMissions().find((x) => x.id === missionId);
  return m ? m.mission : "";
}

function buildInstructions(dir: "in" | "out", missionId?: string): string {
  const c = conf();
  let text = c.instructions || "You are a phone agent making and receiving real phone calls on behalf of its user.";
  if (dir === "out") {
    const m = missionText(missionId);
    if (m) {
      text +=
        "\n\nCURRENT MISSION — work toward it during this call:\n" +
        m +
        "\nConfirm important details out loud. When the mission is complete or clearly impossible, say a short spoken summary of the outcome, say goodbye, and use the hang_up_call tool.";
    }
  } else {
    text += "\n\nYou just answered an incoming call on this line. Greet briefly, find out who is calling and what they need.";
  }
  return text;
}

function toolDefs(): any[] {
  const c = conf();
  const caps = c.capabilities || "search the web, manage files, run code, use installed plugins";
  return [
    {
      type: "function",
      name: "delegate_openbot",
      description:
        "Delegate a task to the user's open-bot desktop agent and get the result during the call. The desktop agent can: " +
        caps +
        ". Use it when the caller asks something that needs real actions or live information. Pass a clear, self-contained task in the caller's language.",
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "The task for the desktop agent, self-contained" } },
        required: ["task"],
      },
    },
    {
      type: "function",
      name: "start_thread",
      description:
        "Open a background thread on the user's open-bot desktop for follow-up work that should continue after the call (long research, ordering, writing). Tell the caller their request is being handled.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "What the thread should handle, self-contained, in the user's language" } },
        required: ["topic"],
      },
    },
    {
      type: "function",
      name: "hang_up_call",
      description: "End the phone call. Use it when the conversation is finished or the caller says goodbye.",
      parameters: { type: "object", properties: {} },
    },
  ];
}

function addTurn(b: Bridge, role: Turn["role"], text: string) {
  text = text.trim();
  if (!text) return;
  const last = b.rec.transcript?.[b.rec.transcript.length - 1];
  if (last && last.role === role && last.text === text) return;
  b.rec.transcript = b.rec.transcript || [];
  b.rec.transcript.push({ role, text: text.slice(0, 2000), ts: new Date().toISOString() });
  b.saveDirty = true;
}

function saveBridge(b: Bridge, force = false) {
  if (b.inert) return;
  if (!force && !b.saveDirty) return;
  b.saveDirty = false;
  b.rec.durationSec = Math.round((Date.now() - b.startedAt) / 1000);
  saveDetail(b.rec);
  upsertSummary(b.rec);
}

function xaiSend(b: Bridge, obj: unknown) {
  try {
    b.xai?.send(JSON.stringify(obj));
  } catch {}
}

function toolOutput(b: Bridge, callId: string, output: string) {
  xaiSend(b, {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: String(output).slice(0, 4000) },
  });
  xaiSend(b, { type: "response.create" });
}

function pollDelegations(b: Bridge) {
  for (const [callId, d] of b.delegations) {
    d.tries++;
    const res = readJson<{ result?: string } | null>(`delegate-result-${d.id}.json`, null);
    if (res) {
      b.delegations.delete(callId);
      toolOutput(b, callId, String(res.result ?? "(empty response)"));
      try {
        const fs = require("node:fs");
        fs.unlinkSync(join(DATA_DIR, `delegate-result-${d.id}.json`));
      } catch {}
    } else if (d.tries > Math.ceil(b ? conf().delegate_timeout / 2 : 120)) {
      b.delegations.delete(callId);
      toolOutput(b, callId, "The task did not finish in time.");
    }
  }
}

function openXai(b: Bridge) {
  const c = conf();
  if (!c.xaiKey) {
    b.rec.error = "No xAI API key configured — the agent could not start.";
    addTurn(b, "agent", "(no xAI key — agent offline)");
    saveBridge(b, true);
    return;
  }
  // xAI realtime needs an ephemeral client secret (same path the Voice Agent tab uses).
  fetch((c.gatewayBase || "https://api.x.ai") + "/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${c.xaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 300 } }),
  })
    .then(async (res) => {
      const text = await res.text();
      let j: any = text;
      try {
        j = JSON.parse(text);
      } catch {}
      const token = String(
        j?.value ?? j?.token ?? j?.client_secret?.value ?? j?.client_secret?.token ?? j?.ephemeral_token ?? j?.secret ?? "",
      );
      if (!token) {
        b.rec.error = "xAI token mint failed (" + res.status + "): " + String(text).slice(0, 160);
        saveBridge(b, true);
        return;
      }
      connectXai(b, c, token);
    })
    .catch((e) => {
      b.rec.error = "xAI token mint error: " + String(e).slice(0, 160);
      saveBridge(b, true);
    });
}

function connectXai(b: Bridge, c: ReturnType<typeof conf>, token: string) {
  b.xaiTries++;
  b.xaiReady = false;
  b.xai = undefined;
  // The realtime WS host follows gateway_base so tests can stub the model
  // (production default: wss://api.x.ai).
  const wsBase = (c.gatewayBase || "https://api.x.ai").trim().replace(/\/+$/, "").replace(/^http/i, "ws");
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${wsBase}/v1/realtime?model=${encodeURIComponent(c.model)}`, [
      "xai-client-secret." + token,
    ]);
  } catch (e) {
    b.rec.error = "xAI websocket failed: " + String(e).slice(0, 160);
    saveBridge(b, true);
    return;
  }
  b.xai = ws;
  ws.addEventListener("open", () => {
    b.xaiReady = true;
    xaiSend(b, {
      type: "session.update",
      session: {
        voice: c.voice,
        instructions: buildInstructions(b.dir, b.missionId),
        turn_detection: { type: "server_vad" },
        tools: toolDefs(),
      },
    });
    for (const chunk of b.queuedIn.splice(0, 300)) xaiSend(b, { type: "input_audio_buffer.append", audio: chunk });
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const t = String(m.type || "");
    if (process.env.PA_DEBUG && t !== "ping") console.log(`[phone-agent] xai<${b.callSid}> ${t}`);
    if (t === "response.output_audio.delta" || t === "response.audio.delta") {
      const audio = String(m.delta || m.audio || "");
      if (audio && b.streamSid) {
        const pcm = downsample3(b64ToPcm(audio));
        b.twilio.send(
          JSON.stringify({ event: "media", streamSid: b.streamSid, media: { payload: pcmToMulawB64(pcm) } }),
        );
      }
    } else if (t.includes("input_audio_transcription")) {
      const tr = String(m.transcript ?? "");
      if (tr.trim()) addTurn(b, "caller", tr);
    } else if (t.includes("output_audio_transcript")) {
      const d = String(m.delta ?? m.text ?? "");
      if (d) {
        b.agentBuf = (b.agentBuf + d).slice(-4000);
        b.saveDirty = true;
      }
    } else if (t === "response.done" || t === "response.completed") {
      if (b.agentBuf.trim()) addTurn(b, "agent", b.agentBuf);
      b.agentBuf = "";
    } else if (t === "response.output_item.done" && m.item?.type === "function_call") {
      runTool(b, m.item);
    } else if (t === "error") {
      const d = (m.error && (m.error.message || m.error.code)) || JSON.stringify(m.error || m).slice(0, 200);
      b.rec.error = String(d).slice(0, 300);
      saveBridge(b, true);
    }
  });
  ws.addEventListener("close", () => {
    if (b.agentBuf.trim()) addTurn(b, "agent", b.agentBuf);
    b.agentBuf = "";
    b.xaiReady = false;
    // The socket died while the call is still live — a transient xAI hiccup,
    // at startup (open then immediate drop) or mid-call. The call would stay
    // silently mute: re-mint and reconnect; buffered caller audio keeps
    // queueing meanwhile. Call-end paths all remove the bridge first, so a
    // dead call never retries.
    if (bridges.get(b.callSid) === b && b.rec.status === "in-progress") {
      if (b.xaiTries < 3) {
        addTurn(b, "whisper", "(speech model reconnecting…)");
        setTimeout(() => {
          if (bridges.get(b.callSid) === b && !b.xaiReady) openXai(b);
        }, 1500);
      } else if (!b.rec.error) {
        b.rec.error = "Speech model connection failed after " + b.xaiTries + " attempts.";
        saveBridge(b, true);
      }
    }
  });
  ws.addEventListener("error", () => {
    b.rec.error = b.rec.error || "xAI connection error.";
  });
}

function runTool(b: Bridge, item: any) {
  const name = String(item.name || "");
  let args: any = {};
  try {
    args = JSON.parse(item.arguments || "{}");
  } catch {}
  if (name === "delegate_openbot") {
    const task = String(args.task || "").trim();
    if (!task) {
      toolOutput(b, item.call_id, "No task was provided.");
      return;
    }
    const id = crypto.randomUUID().slice(0, 8);
    writeJson(`delegate-task-${id}.json`, { task });
    spawnWorker(["delegate", id]);
    b.delegations.set(String(item.call_id), { id, tries: 0 });
    addTurn(b, "whisper", `[delegate] ${task}`);
  } else if (name === "start_thread") {
    const topic = String(args.topic || "").trim();
    if (topic) spawnDetachedThread(topic);
    toolOutput(b, item.call_id, topic ? "Thread started in the background; the user can follow it on the dashboard." : "No topic was provided.");
    addTurn(b, "whisper", `[thread] ${topic}`);
  } else if (name === "hang_up_call") {
    toolOutput(b, item.call_id, "Call ended.");
    b.hangupAt = Date.now();
    setTimeout(() => {
      hangupCall(b.callSid);
    }, 1800); // let the goodbye audio flush
  } else {
    toolOutput(b, item.call_id, `Unknown tool: ${name}`);
  }
}

function closeBridge(callSid: string, reason: string) {
  const b = bridges.get(callSid);
  if (!b) return;
  bridges.delete(callSid);
  if (b.timer) clearInterval(b.timer);
  try {
    b.xai?.close();
  } catch {}
  if (b.inert) {
    // Never identified: nothing was recorded, nothing to persist.
    console.log(`[phone-agent] inert socket dropped ${callSid}: ${reason}`);
    return;
  }
  b.rec.status = b.rec.status === "in-progress" ? "completed" : b.rec.status;
  saveBridge(b, true);
  console.log(`[phone-agent] bridge closed ${callSid}: ${reason}`);
}

function handleTwilioSocket(ws: any, params: URLSearchParams) {
  const callSid = params.get("call") || "unknown";
  const dir = params.get("dir") === "in" ? "in" : "out";
  const missionId = params.get("mission") || undefined;
  // Queryless upgrade (some Twilio edge builds strip the wss query string):
  // the bridge stays INERT — no record, no model session, no polling — until
  // a real "start" event identifies the call on this socket. Nobody can talk
  // to the model or touch records through an unidentified socket.
  const inert = callSid === "unknown";
  const now = new Date().toISOString();
  const prev = inert ? null : loadDetail(callSid);
  const missionRec = missionId ? loadMissions().find((x) => x.id === missionId) : undefined;
  const b: Bridge = {
    twilio: ws,
    streamSid: "",
    callSid,
    dir,
    missionId,
    xaiReady: false,
    xaiTries: 0,
    queuedIn: [],
    rec:
      prev ??
      ({
        callSid,
        direction: dir,
        to: dir === "out" ? missionRec?.to || params.get("to") || undefined : params.get("to") || undefined,
        from: dir === "in" ? params.get("from") || undefined : undefined,
        status: "in-progress",
        startedAt: now,
        missionId,
        transcript: [],
      } as CallRec),
    agentBuf: "",
    lastTurnAt: Date.now(),
    saveDirty: true,
    delegations: new Map(),
    hangupAt: 0,
    startedAt: Date.now(),
    timer: null,
    inert,
  };
  if (inert) {
    bridges.set(callSid, b);
    console.log("[phone-agent] unidentified media socket — waiting for start event");
    return;
  }
  b.rec.status = "in-progress";
  b.rec.answered = true;
  bridges.set(callSid, b);
  b.timer = setInterval(() => {
    pollDelegations(b);
    if (Date.now() - b.startedAt > MAX_CALL_SEC * 1000) {
      b.rec.error = "Hard time limit reached.";
      hangupCall(callSid);
    }
  }, 2000);
  saveBridge(b, true);
  openXai(b);
  console.log(`[phone-agent] bridge open ${callSid} dir=${dir} mission=${missionId ?? "-"}`);
}

function onTwilioMessage(ws: any, raw: string | Buffer) {
  let m: any;
  try {
    m = JSON.parse(String(raw));
  } catch {
    return;
  }
  const ev = String(m.event || "");
  if (ev === "start") {
    const mp = m.start?.customParameters ?? {};
    const callSid = String(m.start?.callSid || mp.callSid || "unknown");
    let b = bridges.get(callSid);
    if (!b) {
      // Some Twilio edge builds drop the query string on the wss URL, so the
      // bridge was keyed "unknown" (or ws.data holds no callSid). Adopt the
      // orphaned bridge and re-key it to the real callSid so media, records
      // and mission linkage work.
      const altKey = ws.data?.callSid && bridges.has(ws.data.callSid) ? ws.data.callSid : "unknown";
      b = bridges.get(altKey);
      if (!b) return;
      bridges.delete(altKey);
      b.callSid = callSid;
      b.rec.callSid = callSid;
      // Bind the bridge to THIS socket: media and xAI audio must flow over the
      // connection the provider actually opened, never a stale one.
      b.twilio = ws;
      if (ws.data) ws.data.callSid = callSid;
      if (b.rec.missionId === undefined && mp.mission) b.missionId = String(mp.mission);
      bridges.set(callSid, b);
      b.saveDirty = true;
      // Drop the orphaned pre-key brief/detail so no stale call lingers.
      try {
        saveCalls(loadCalls().filter((c) => c.callSid !== altKey));
        require("node:fs").rmSync(join(DATA_DIR, detailFile(altKey)), { force: true });
      } catch {}
      if (b.inert) {
        // Unidentified socket now proven to carry a real call: activate it.
        b.inert = false;
        b.timer = setInterval(() => {
          pollDelegations(b);
          if (Date.now() - b.startedAt > MAX_CALL_SEC * 1000) {
            b.rec.error = "Hard time limit reached.";
            hangupCall(callSid);
          }
        }, 2000);
        openXai(b);
      }
      saveBridge(b, true);
      console.log(`[phone-agent] bridge re-keyed to ${callSid} (was "${altKey}")`);
    }
    b.streamSid = String(m.start?.streamSid || "");
    if (!b.missionId && mp.mission) b.missionId = String(mp.mission);
    if (!b.rec.missionId && b.missionId) b.rec.missionId = b.missionId;
    if (!b.rec.from && mp.from) b.rec.from = String(mp.from);
    if (!b.rec.to && mp.to) b.rec.to = String(mp.to);
    b.saveDirty = true;
  } else if (ev === "media") {
    const callSid = ws.data?.callSid;
    const b = bridges.get(callSid);
    if (!b) return;
    const payload = String(m.media?.payload || "");
    if (!payload) return;
    if (!b.xaiReady) {
      // No live session yet (model connecting or reconnecting): buffer the
      // caller's audio so nothing spoken is lost.
      b.queuedIn.push(payload);
      if (b.queuedIn.length > 300) b.queuedIn.shift();
      return;
    }
    const pcm = upsample3(mulawToPcm(payload));
    xaiSend(b, { type: "input_audio_buffer.append", audio: pcmToB64(pcm) });
  } else if (ev === "stop") {
    const callSid = ws.data?.callSid;
    if (callSid) closeBridge(callSid, "stream stop");
  }
}

/* ---------------- call finalization (status callback) ---------------- */

const TERMINAL = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

function finalizeFromStatus(callSid: string, callStatus: string, duration: number, missionId?: string) {
  const list = loadCalls();
  const brief = list.find((c) => c.callSid === callSid);
  const detail = loadDetail(callSid) ?? (brief ? { ...brief, transcript: [] } : null);
  if (!detail) {
    // No local record (e.g. server restarted mid-call): at least settle the mission.
    if (missionId && TERMINAL.has(callStatus)) {
      const missions = loadMissions();
      const m = missions.find((x) => x.id === missionId);
      if (m && !m.endedAt) {
        m.status = "failed";
        m.endedAt = new Date().toISOString();
        m.report = `Call ended (${callStatus}) but no conversation record survived (plugin restart).`;
        saveMissions(missions);
      }
    }
    return;
  }
  detail.status = callStatus;
  if (TERMINAL.has(callStatus)) {
    detail.endedAt = detail.endedAt || new Date().toISOString();
    if (duration > 0) detail.durationSec = duration;
    detail.answered = (detail.durationSec ?? 0) >= 5;
    closeBridge(callSid, "status " + callStatus);
    saveDetail(detail);
    upsertSummary(detail);
    if (detail.missionId) {
      setTimeout(() => spawnWorker(["report", callSid]), 800);
    } else if (detail.direction === "in" && !detail.answered) {
      try {
        Bun.spawn(["ob-plugin", "notify", PLUGIN_ID, "Phone agent", `Missed incoming call from ${detail.from ?? "unknown"}.`], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {}
    }
  } else {
    upsertSummary(detail);
  }
}

/* ---------------- page UI (bundled) ----------------
 * The frontend lives in real files next to this server: index.html + app.ts +
 * styles.css (moved verbatim from the former template strings). At install the
 * control plane bundles them into one self-contained HTML and hands it over
 * via OPEN_BOT_PAGE_UI. Local checkouts / previews rebuild the same single
 * self-contained page at startup with the official bundler (bun --hot re-runs
 * this on every edit) — the page stays inline everywhere, including behind
 * the dashboard proxy, and only the source HTML import is left as fallback. */

const UI_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };
const UI_BUNDLE = process.env.OPEN_BOT_PAGE_UI || "";

let devPage: string | null = null;
try {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "index.html")],
    target: "browser",
    compile: true,
  } as never);
  const html = built.outputs.find((o) => o.path.endsWith(".html"));
  if (html) devPage = await html.text();
} catch {}

function pageResponse(): Response {
  if (UI_BUNDLE) return new Response(Bun.file(UI_BUNDLE), { headers: UI_HEADERS });
  if (devPage !== null) return new Response(devPage, { headers: UI_HEADERS });
  return new Response(null, { status: 307, headers: { location: "/" } });
}

const routes: Record<string, unknown> = UI_BUNDLE
  ? {
      "/": (): Response => pageResponse(),
    }
  : { "/": devPage !== null ? (): Response => pageResponse() : await import("./index.html").then((m) => m.default) };

/* ---------------- APIs ---------------- */

function json(res: unknown, status = 200): Response {
  return new Response(JSON.stringify(res), { status, headers: { "content-type": "application/json" } });
}

async function apiStatus() {
  const c = conf();
  const { settings: set, vault: val } = loadConfig();
  const s = set ?? {};
  const v = val ?? {};
  const tw = telConf({ ...s, phone_provider: "twilio" }, v);
  const sw = telConf({ ...s, phone_provider: "signalwire" }, v);
  const t = c.tel;
  const calls = loadCalls();
  const active = calls.filter((x) => !x.endedAt && !TERMINAL.has(x.status));
  return json({
    plugin: PLUGIN_ID,
    hasKey: Boolean(c.xaiKey),
    phoneProvider: t.provider,
    twilio: { sid: Boolean(tw.sid), token: Boolean(tw.token), phone: tw.phone },
    signalwire: {
      space: Boolean(c.swSpace),
      project: Boolean(sw.sid),
      token: Boolean(sw.token),
      phone: sw.phone,
    },
    tel: { sid: Boolean(t.sid), token: Boolean(t.token), phone: t.phone },
    publicBase: c.publicBase,
    autoAnswer: c.autoAnswer,
    verify: t.provider === "signalwire" ? c.swVerify : c.verify,
    model: c.model,
    voice: c.voice,
    active: active.length,
    ready: Boolean(c.xaiKey && t.sid && t.token && t.phone && c.publicBase),
  });
}

function apiCalls(full: string | null) {
  if (full) return json({ call: loadDetail(full) });
  return json({ calls: loadCalls().slice(-60).reverse() });
}

function apiMissions() {
  return json({ missions: loadMissions().slice(-60).reverse() });
}

async function apiWhisper(req: Request) {
  let b: any = {};
  try {
    b = await req.json();
  } catch {}
  const callSid = String(b.callSid || "");
  const text = String(b.text || "").trim().slice(0, 500);
  const bridge = bridges.get(callSid);
  if (!bridge) return json({ ok: false, error: "no_live_call" }, 404);
  if (!text) return json({ ok: false, error: "empty" }, 400);
  if (!bridge.xaiReady) return json({ ok: false, error: "agent_not_ready" }, 409);
  xaiSend(bridge, {
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "Whispered note from your operator (the person you work for) — not the caller: " + text }],
    },
  });
  xaiSend(bridge, { type: "response.create" });
  addTurn(bridge, "whisper", "[whisper] " + text);
  saveBridge(bridge, true);
  return json({ ok: true });
}

/* ---------------- server ---------------- */

const server = Bun.serve({
  port: PORT,
  routes: routes as never,
  websocket: {
    open(ws) {
      const data = (ws as any).data as { query?: string; callSid?: string } | undefined;
      // Always open a bridge. Some Twilio edge builds drop the query string
      // from the wss url, so callSid can be missing here; the bridge is then
      // keyed "unknown" and re-keyed to the real callSid when the "start"
      // event arrives (see onTwilioMessage).
      handleTwilioSocket(ws, new URLSearchParams(data?.query || ""));
    },
    message(ws, msg) {
      onTwilioMessage(ws, msg as string);
    },
    close(ws) {
      const callSid = (ws as any).data?.callSid;
      if (callSid) closeBridge(callSid, "socket close");
    },
  },
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";

    if (p === "/healthz") return new Response("ok");

    /* WebSocket for Twilio media (public hook: /hooks/phone-agent/media) */
    if (p === "/media") {
      // Per-call token gate: any upgrade that CARRIES stream parameters must
      // present the token the server baked into the wss URL for that exact
      // call (fail closed when no secret is configured). Queryless upgrades
      // (Twilio edge builds that strip the query) are allowed through but the
      // bridge stays inert until a real "start" event identifies the call.
      const call = url.searchParams.get("call");
      if (call) {
        const want = mediaToken(call, url.searchParams.get("dir") || "", url.searchParams.get("mission") || "");
        if (!want || url.searchParams.get("t") !== want) {
          return new Response("unauthorized", { status: 401 });
        }
      }
      const ok = server.upgrade(req, {
        data: { callSid: call || undefined, query: url.search || "" },
      });
      return ok ? undefined : new Response("ws upgrade failed", { status: 400 });
    }

    /* dashboard pages (dashboard proxy prefixes get stripped by it; these are clean paths) */
    if (p === "/index.html" || p === "/missions" || p === "/settings") {
      // legacy paths of the one merged app (in-app nav switches sections via
      // hash: #calls #missions #settings) — same UI as the "/" route above
      return pageResponse();
    }

    /* APIs — tolerate the /missions and /settings page prefixes from relative fetches */
    const apiPath = p.replace(/^\/(missions|settings)(?=\/api\/)/, "");

    if (apiPath === "/api/status") return apiStatus();
    if (apiPath === "/api/settings") return apiStatus(); // same readiness payload
    if (apiPath === "/api/calls") return apiCalls(url.searchParams.get("full"));
    if (apiPath === "/api/missions") return apiMissions();

    if (apiPath === "/api/missions/place" && req.method === "POST") {
      let b: any = {};
      try {
        b = await req.json();
      } catch {}
      const to = String(b.to || "").trim();
      const mission = String(b.mission || "").trim();
      if (!to || !mission) return json({ ok: false, error: "bad_request", hint: "to and mission are required" }, 400);
      const r = await runCli("call", ["--to", to, "--mission", mission]);
      return json(r, r.ok ? 200 : 400);
    }

    if (apiPath === "/api/hangup" && req.method === "POST") {
      let b: any = {};
      try {
        b = await req.json();
      } catch {}
      const r = await runCli("hangup", b.callSid ? ["--callsid", String(b.callSid)] : []);
      return json(r, r.ok ? 200 : 400);
    }

    if (apiPath === "/api/whisper" && req.method === "POST") return apiWhisper(req);

    /* Telephony webhooks (public: /hooks/phone-agent/twilio/… or /signalwire/…).
       Both providers speak TwiML/cXML with the same form-encoded params, so the
       handlers are shared; only the signature scheme differs. */
    const hookProvider = p.startsWith("/twilio/") ? "twilio" : p.startsWith("/signalwire/") ? "signalwire" : null;
    if (hookProvider) {
      const params = await formParams(req);
      const c = conf();
      const wantVerify = hookProvider === "signalwire" ? c.swVerify : c.verify;
      if (wantVerify && !hookSigned(req, params, hookProvider)) {
        return new Response("bad signature", { status: 403 });
      }
      const callSid = params.CallSid || url.searchParams.get("call") || "";

      if (p.endsWith("/voice") && req.method === "POST") {
        const rec: CallRec = {
          callSid,
          direction: "in",
          from: params.From || "unknown",
          to: params.To,
          status: "ringing",
          startedAt: new Date().toISOString(),
          transcript: [],
        };
        upsertSummary(rec);
        saveDetail(rec);
        try {
          Bun.spawn(["ob-plugin", "notify", PLUGIN_ID, "Phone Agent", `Incoming call from ${rec.from}`], {
            stdout: "ignore",
            stderr: "ignore",
          });
        } catch {}
        if (!c.autoAnswer) {
          return twiml(
            '<Say language="en-US">The assistant is not available on this line right now. Goodbye.</Say><Hangup/>',
          );
        }
        return twiml(
          `<Connect><Stream url="${xmlAttr(streamUrl({ call: callSid, dir: "in", from: params.From || "", to: params.To || "" }))}"/>` +
            `<Parameter name="callSid" value="${xmlAttr(callSid)}"/>` +
            `<Parameter name="from" value="${xmlAttr(params.From || "")}"/>` +
            `<Parameter name="to" value="${xmlAttr(params.To || "")}"/>` +
            `</Connect>`,
        );
      }

      if (p.endsWith("/outbound") && req.method === "POST") {
        const missionId = url.searchParams.get("mission") || undefined;
        return twiml(
          `<Connect><Stream url="${xmlAttr(streamUrl({ call: callSid, dir: "out", mission: missionId ?? "" }))}"/>` +
            `<Parameter name="callSid" value="${xmlAttr(callSid)}"/>` +
            (missionId ? `<Parameter name="mission" value="${xmlAttr(missionId)}"/>` : "") +
            `</Connect>`,
        );
      }

      if (p.endsWith("/status") && req.method === "POST") {
        finalizeFromStatus(
          callSid,
          params.CallStatus || "",
          Math.round(Number(params.CallDuration ?? 0)),
          url.searchParams.get("mission") || undefined,
        );
        return twiml("");
      }

      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`phone-agent page server on :${PORT}`);

/* keep delegate polling + bridge saves ticking even without media */
setInterval(() => {
  for (const b of bridges.values()) {
    pollDelegations(b);
    saveBridge(b);
  }
}, 3000);
