#!/usr/bin/env bun
/**
 * phone-agent — dashboard page server (Bun). One process, three jobs:
 *
 *  1. Dashboard tabs (proxied under /api/pages/phone-agent/):
 *     GET /            → Calls page (live calls, transcript, whisper mic, history)
 *     GET /missions    → Missions page (place a call, follow reports)
 *     GET /settings    → Settings page (readiness checklist, webhook URLs)
 *     APIs: api/status, api/calls, api/calls?full=<sid>, api/missions,
 *           api/missions/place (POST), api/hangup (POST), api/whisper (POST)
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

function streamUrl(extra: Record<string, string>): string {
  const c = conf();
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
  b.rec.status = b.rec.status === "in-progress" ? "completed" : b.rec.status;
  saveBridge(b, true);
  console.log(`[phone-agent] bridge closed ${callSid}: ${reason}`);
}

function handleTwilioSocket(ws: any, params: URLSearchParams) {
  const callSid = params.get("call") || "unknown";
  const dir = params.get("dir") === "in" ? "in" : "out";
  const missionId = params.get("mission") || undefined;
  const now = new Date().toISOString();
  const prev = loadDetail(callSid);
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
  };
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
      if (ws.data) ws.data.callSid = callSid;
      if (b.rec.missionId === undefined && mp.mission) b.missionId = String(mp.mission);
      bridges.set(callSid, b);
      b.saveDirty = true;
      // Drop the orphaned pre-key brief/detail so no stale call lingers.
      try {
        saveCalls(loadCalls().filter((c) => c.callSid !== altKey));
        require("node:fs").rmSync(join(DATA_DIR, detailFile(altKey)), { force: true });
      } catch {}
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

/* ---------------- pages: shared chrome ---------------- */

function themeScript(): string {
  return (
    "(function(){try{var q=new URLSearchParams(location.search).get('theme');" +
    "var t=(q==='light'||q==='dark')?q:((window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light');" +
    "document.documentElement.setAttribute('data-theme',t);" +
    "if(window.matchMedia){var mq=window.matchMedia('(prefers-color-scheme: dark)');" +
    "var h=function(e){if(!(new URLSearchParams(location.search).get('theme'))){document.documentElement.setAttribute('data-theme',e.matches?'dark':'light');}};" +
    "if(mq.addEventListener){mq.addEventListener('change',h);}else if(mq.addListener){mq.addListener(h);}}}catch(e){}})();"
  );
}

function baseCss(): string[] {
  return [
    ":root{--bg:#f5f6f8;--card:#ffffff;--line:#d9dde3;--tx:#161a22;--dim:#5b6472;--acc:#2b6be0;--ok:#177a43;--warn:#8a5a00;--err:#c93a3a;--btn:#e8ebf0;--btnline:#cfd4dc;--in:#7a3ce0}",
    "html[data-theme=\"dark\"]{--bg:#0f1115;--card:#171a21;--line:#262b36;--tx:#e7eaf0;--dim:#98a1b3;--acc:#4f8cff;--ok:#37c978;--warn:#ffb44d;--err:#ff6161;--btn:#232936;--btnline:#262b36;--in:#b18cff}",
    "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}",
    ".wrap{max-width:820px;margin:0 auto;padding:24px 16px 48px}",
    "h1{font-size:22px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 20px;font-size:14px}",
    ".banner{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:16px;font-size:14px}",
    ".banner.ok{border-color:var(--ok)}.banner.setup{border-color:var(--warn)}.banner.err{border-color:var(--err)}.banner.ring{border-color:var(--in);background:rgba(122,60,224,.06);font-weight:600}",
    ".card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}",
    ".pill{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 10px;color:var(--dim)}",
    ".pill.live{color:var(--ok);border-color:var(--ok)}.pill.ring{color:var(--in);border-color:var(--in)}.pill.err{color:var(--err);border-color:var(--err)}",
    ".navrow{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}.navbtn{border-radius:999px;padding:7px 18px;font-size:14px}.navbtn.on{background:var(--acc);color:#fff;border-color:var(--acc)}",
    ".dir{font-size:12px;font-weight:600}.dir.out{color:var(--acc)}.dir.in{color:var(--in)}",
    "button{background:var(--btn);color:var(--tx);border:1px solid var(--btnline);border-radius:9px;padding:7px 14px;cursor:pointer;font-size:13px}",
    "button:hover{border-color:var(--acc)}button.danger{color:var(--err);border-color:var(--err)}button.primary{background:var(--acc);color:#fff;border-color:var(--acc)}",
    "input[type=text],textarea{width:100%;background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:9px;padding:8px 10px;font:inherit;font-size:14px}",
    "textarea{min-height:90px;resize:vertical}label{font-size:13px;color:var(--dim);display:block;margin:10px 0 4px}",
    "#log{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:10px}",
    ".msg{padding:7px 12px;border-bottom:1px solid var(--line);font-size:14px}.msg:last-child{border-bottom:none}",
    ".msg .who{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);display:block;margin-bottom:1px}",
    ".msg.agent .who{color:var(--acc)}.msg.caller .who{color:var(--ok)}.msg.whisper{color:var(--dim);font-style:italic}",
    "table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}th{color:var(--dim);font-weight:500}",
    ".empty{color:var(--dim);padding:14px;text-align:center;font-size:13px}",
    ".row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}",
    ".mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all}",
    ".ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}",
    "details{margin-top:8px}summary{cursor:pointer;font-size:13px;color:var(--acc)}",
    "a{color:var(--acc)}code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 5px;font-size:12.5px}",
  ];
}

function htmlDoc(lang: string, title: string, body: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark"><title>' + title + "</title>",
    "<script>" + themeScript() + "</script>",
    "<style>" + baseCss().join("") + "</style></head><body>",
    body,
    "</body></html>",
  ].join("");
}

/* i18n dicts (en/fr/es/de) shared by the three pages */
const L = {
  en: {
    callsSub: "Live calls and history. The agent answers with the settings below.",
    missionsSub: "Give the agent a mission: it calls, talks, and reports back here.",
    settingsSub: "What is configured, and what is still missing.",
    ready: "Ready — calls can be placed.",
    setup: "Setup needed — see the Settings tab.",
    net: "Could not reach the plugin server.",
    live: "Live", history: "History", missions: "Missions", newMission: "New mission",
    when: "When", dirLabel: "Dir", number: "Number", dur: "Duration", status: "Status", report: "Report",
    out: "Out", in: "In",
    noCalls: "No calls yet.", noMissions: "No missions yet.",
    to: "To (E.164, e.g. +18195550123)", missionText: "Mission for the agent (self-contained, in the callee's language)",
    place: "Place the call", placing: "Placing…",
    transcript: "Transcript", whisperPh: "Whisper an instruction to the agent…", whisperSend: "Send",
    hangup: "Hang up", incoming: "Incoming call", from: "from", answeredByAgent: "answered by the agent",
    you: "Operator", agent: "Agent", caller: "Caller",
    settingsChecks: "Checklist", set: "set", missing: "missing",
    kxai: "xAI API key (Grok Voice)", ksid: "Twilio Account SID", ktok: "Twilio Auth Token",
    kphone: "Twilio phone number", kbase: "Public endpoint URL (Config → Endpoints)",
    kswSpace: "SignalWire Space name", kswProject: "SignalWire Project ID", kswToken: "SignalWire API token",
    kswPhone: "SignalWire phone number",
    phoneProvider: "Phone provider", twilioName: "Twilio", signalwireName: "SignalWire",
    webhooks: "{p} number wiring",
    webhookHelp: "In the {p} console, on your phone number, set “A call comes in” to the Voice URL below (HTTP POST). The status callback is optional.",
    voiceUrl: "Voice URL", statusUrl: "Status callback (optional)",
    current: "Current values", model: "Model", voice: "Voice", autoAnswer: "Auto-answer incoming calls",
    verify: "Verify Twilio signatures", place2: "Place a mission from any thread with:",
    costsNote: "Calls use your Twilio account and your xAI key — normal billing applies.",
    fromThread: "From a thread",
    navCalls: "Calls",navMissions: "Missions",navSettings: "Settings",
  },
  fr: {
    callsSub: "Appels en direct et historique. L'agent répond avec les réglages ci-dessous.",
    missionsSub: "Donne une mission à l'agent : il appelle, parle, et rend compte ici.",
    settingsSub: "Ce qui est configuré, et ce qui manque encore.",
    ready: "Prêt — les appels peuvent partir.",
    setup: "Configuration requise — vois l'onglet Réglages.",
    net: "Serveur du plugin injoignable.",
    live: "En direct", history: "Historique", missions: "Missions", newMission: "Nouvelle mission",
    when: "Quand", dirLabel: "Sens", number: "Numéro", dur: "Durée", status: "Statut", report: "Compte rendu",
    out: "Sortant", in: "Entrant",
    noCalls: "Aucun appel pour le moment.", noMissions: "Aucune mission pour le moment.",
    to: "Vers (E.164, ex. +18195550123)", missionText: "Mission pour l'agent (autonome, dans la langue de l'appelé)",
    place: "Passer l'appel", placing: "Appel en cours…",
    transcript: "Transcription", whisperPh: "Souffle une instruction à l'agent…", whisperSend: "Envoyer",
    hangup: "Raccrocher", incoming: "Appel entrant", from: "de", answeredByAgent: "répondu par l'agent",
    you: "Toi", agent: "Agent", caller: "Correspondant",
    settingsChecks: "Liste de vérification", set: "configuré", missing: "manquant",
    kxai: "Clé API xAI (Grok Voice)", ksid: "Twilio Account SID", ktok: "Twilio Auth Token",
    kphone: "Numéro de téléphone Twilio", kbase: "URL d'endpoint public (Config → Endpoints)",
    kswSpace: "Nom d'espace SignalWire", kswProject: "ID de projet SignalWire", kswToken: "Jeton API SignalWire",
    kswPhone: "Numéro de téléphone SignalWire",
    phoneProvider: "Fournisseur téléphonique", twilioName: "Twilio", signalwireName: "SignalWire",
    webhooks: "Raccordement du numéro {p}",
    webhookHelp: "Dans la console {p}, sur ton numéro, mets « A call comes in » sur l'URL Voice ci-dessous (HTTP POST). Le callback de statut est optionnel.",
    voiceUrl: "URL Voice", statusUrl: "Callback de statut (optionnel)",
    current: "Valeurs actuelles", model: "Modèle", voice: "Voix", autoAnswer: "Réponse auto aux appels entrants",
    verify: "Vérifier les signatures Twilio", place2: "Lance une mission depuis n'importe quel fil avec :",
    costsNote: "Les appels utilisent ton compte Twilio et ta clé xAI — facturation normale.",
    fromThread: "Depuis un fil",
    navCalls: "Appels",navMissions: "Missions",navSettings: "Réglages",
  },
  es: {
    callsSub: "Llamadas en vivo e historial. El agente responde con los ajustes de abajo.",
    missionsSub: "Dale una misión al agente: llama, habla y da cuenta aquí.",
    settingsSub: "Lo que está configurado y lo que falta.",
    ready: "Listo — se pueden hacer llamadas.",
    setup: "Configuración necesaria — mira la pestaña Ajustes.",
    net: "No se pudo contactar el servidor del plugin.",
    live: "En vivo", history: "Historial", missions: "Misiones", newMission: "Nueva misión",
    when: "Cuándo", dirLabel: "Sentido", number: "Número", dur: "Duración", status: "Estado", report: "Informe",
    out: "Saliente", in: "Entrante",
    noCalls: "Aún no hay llamadas.", noMissions: "Aún no hay misiones.",
    to: "Para (E.164, ej. +18195550123)", missionText: "Misión para el agente (autónoma, en el idioma del destinatario)",
    place: "Llamar", placing: "Llamando…",
    transcript: "Transcripción", whisperPh: "Susúrrale una instrucción al agente…", whisperSend: "Enviar",
    hangup: "Colgar", incoming: "Llamada entrante", from: "de", answeredByAgent: "respondida por el agente",
    you: "Tú", agent: "Agente", caller: "Interlocutor",
    settingsChecks: "Lista de verificación", set: "configurado", missing: "falta",
    kxai: "Clave API de xAI (Grok Voice)", ksid: "Twilio Account SID", ktok: "Twilio Auth Token",
    kphone: "Número de teléfono de Twilio", kbase: "URL pública (Config → Endpoints)",
    kswSpace: "Nombre de espacio SignalWire", kswProject: "ID de proyecto SignalWire", kswToken: "Token de API SignalWire",
    kswPhone: "Número de teléfono SignalWire",
    phoneProvider: "Proveedor telefónico", twilioName: "Twilio", signalwireName: "SignalWire",
    webhooks: "Cableado del número {p}",
    webhookHelp: "En la consola de {p}, en tu número, pon “A call comes in” en la URL de voz de abajo (HTTP POST). El callback de estado es opcional.",
    voiceUrl: "URL de voz", statusUrl: "Callback de estado (opcional)",
    current: "Valores actuales", model: "Modelo", voice: "Voz", autoAnswer: "Respuesta automática a entrantes",
    verify: "Verificar firmas Twilio", place2: "Lanza una misión desde cualquier hilo con:",
    costsNote: "Las llamadas usan tu cuenta de Twilio y tu clave de xAI — facturación normal.",
    fromThread: "Desde un hilo",
    navCalls: "Llamadas",navMissions: "Misiones",navSettings: "Ajustes",
  },
  de: {
    callsSub: "Live-Anrufe und Verlauf. Der Agent antwortet gemäß den Einstellungen unten.",
    missionsSub: "Gib dem Agenten eine Mission: Er ruft an, spricht und berichtet hier.",
    settingsSub: "Was konfiguriert ist und was noch fehlt.",
    ready: "Bereit — Anrufe können gehen.",
    setup: "Einrichtung nötig — siehe Tab Einstellungen.",
    net: "Plugin-Server nicht erreichbar.",
    live: "Live", history: "Verlauf", missions: "Missionen", newMission: "Neue Mission",
    when: "Wann", dirLabel: "Richtung", number: "Nummer", dur: "Dauer", status: "Status", report: "Bericht",
    out: "Ausgehend", in: "Eingehend",
    noCalls: "Noch keine Anrufe.", noMissions: "Noch keine Missionen.",
    to: "An (E.164, z. B. +18195550123)", missionText: "Mission für den Agenten (in sich geschlossen, in der Sprache des Angerufenen)",
    place: "Anrufen", placing: "Rufe…",
    transcript: "Transkript", whisperPh: "Flüstere dem Agenten eine Anweisung zu…", whisperSend: "Senden",
    hangup: "Auflegen", incoming: "Eingehender Anruf", from: "von", answeredByAgent: "vom Agenten beantwortet",
    you: "Du", agent: "Agent", caller: "Anrufer",
    settingsChecks: "Checkliste", set: "gesetzt", missing: "fehlt",
    kxai: "xAI-API-Schlüssel (Grok Voice)", ksid: "Twilio Account SID", ktok: "Twilio Auth Token",
    kphone: "Twilio-Telefonnummer", kbase: "Öffentliche Endpoint-URL (Config → Endpoints)",
    kswSpace: "SignalWire-Space-Name", kswProject: "SignalWire-Projekt-ID", kswToken: "SignalWire-API-Token",
    kswPhone: "SignalWire-Telefonnummer",
    phoneProvider: "Telefonanbieter", twilioName: "Twilio", signalwireName: "SignalWire",
    webhooks: "Verkabelung der {p}-Nummer",
    webhookHelp: "Stelle in der {p}-Konsole bei deiner Nummer „A call comes in“ auf die untenstehende Voice-URL (HTTP POST). Der Status-Callback ist optional.",
    voiceUrl: "Voice-URL", statusUrl: "Status-Callback (optional)",
    current: "Aktuelle Werte", model: "Modell", voice: "Stimme", autoAnswer: "Eingehende Anrufe automatisch annehmen",
    verify: "Twilio-Signaturen prüfen", place2: "Starte eine Mission aus jedem Thread mit:",
    costsNote: "Anrufe nutzen deinen Twilio-Account und deinen xAI-Schlüssel — normale Abrechnung.",
    fromThread: "Aus einem Thread",
    navCalls: "Anrufe",navMissions: "Missionen",navSettings: "Einstellungen",
  },
};

/* ---------------- page: one app, three sections ---------------- */

function appPage(): string {
  const body = [
    '<div class="wrap">',
    '<h1 id="t-title">Phone Agent</h1>',
    '<p class="sub" id="t-sub"></p>',
    '<div class="navrow">',
    '<button class="navbtn" id="nav-calls"></button>',
    '<button class="navbtn" id="nav-missions"></button>',
    '<button class="navbtn" id="nav-settings"></button>',
    "</div>",
    /* ---- calls ---- */
    '<section id="sec-calls">',
    '<div id="c-banner" class="banner setup"></div>',
    '<div id="c-ring" class="banner ring" style="display:none"></div>',
    '<div class="card"><div class="row" style="justify-content:space-between"><strong id="t-live"></strong><span class="pill" id="c-livepill">—</span></div>',
    '<div id="c-livebox"></div></div>',
    '<div class="card"><strong id="t-hist"></strong><div style="margin-top:10px"><table><thead><tr>',
    '<th id="h-when"></th><th id="h-dir"></th><th id="h-num"></th><th id="h-dur"></th><th id="h-st"></th>',
    '</tr></thead><tbody id="c-calls"></tbody></table><div class="empty" id="c-nocalls"></div></div></div>',
    "</section>",
    /* ---- missions ---- */
    '<section id="sec-missions" style="display:none">',
    '<div id="m-banner" class="banner setup"></div>',
    '<div class="card"><strong id="t-new"></strong>',
    '<label id="l-to"></label><input type=text id="m-to" placeholder="+18195550123">',
    '<label id="l-m"></label><textarea id="m-text"></textarea>',
    '<div class="row" style="margin-top:10px"><button class="primary" id="m-place"></button><span id="m-msg" class="sub"></span></div></div>',
    '<div class="card"><strong id="t-list"></strong><div id="m-list" style="margin-top:10px"></div><div class="empty" id="m-nom"></div></div>',
    "</section>",
    /* ---- settings ---- */
    '<section id="sec-settings" style="display:none">',
    '<div id="s-banner" class="banner setup"></div>',
    '<div class="card"><strong id="t-check"></strong><div id="s-checks" style="margin-top:10px"></div></div>',
    '<div class="card"><strong id="t-hooks"></strong><p class="sub" id="t-hookhelp"></p>',
    '<label id="l-vurl"></label><div class="mono" id="s-vurl"></div>',
    '<label id="l-surl"></label><div class="mono" id="s-surl"></div></div>',
    '<div class="card"><strong id="t-cur"></strong><div id="s-cur" style="margin-top:10px"></div></div>',
    '<div class="card"><strong id="t-cli"></strong><p class="sub mono" id="s-cli" style="white-space:pre-wrap"></p></div>',
    "</section>",
    '<p class="sub" id="foot"></p></div><script>',
    appJs(),
    "</script>",
  ].join("");
  return htmlDoc("en", "Phone Agent", body);
}

function appJs(): string {
  return [
    "(function(){",
    "var lang=(navigator.language||'en').slice(0,2).toLowerCase();",
    "var T=(" + JSON.stringify(L) + ")[lang]||(" + JSON.stringify(L) + ").en;",
    "function $(id){return document.getElementById(id)}",
    /* labels */
    "$('t-sub').textContent=T.callsSub;",
    "$('nav-calls').textContent=T.navCalls;$('nav-missions').textContent=T.navMissions;$('nav-settings').textContent=T.navSettings;",
    "$('t-live').textContent=T.live;$('t-hist').textContent=T.history;",
    "$('h-when').textContent=T.when;$('h-dir').textContent=T.dirLabel;$('h-num').textContent=T.number;$('h-dur').textContent=T.dur;$('h-st').textContent=T.status;",
    "$('c-nocalls').textContent=T.noCalls;$('foot').textContent=T.costsNote;",
    "$('t-new').textContent=T.newMission;$('t-list').textContent=T.missions;",
    "$('l-to').textContent=T.to;$('l-m').textContent=T.missionText;$('m-place').textContent=T.place;$('m-nom').textContent=T.noMissions;",
    "$('t-check').textContent=T.settingsChecks;$('l-vurl').textContent=T.voiceUrl;$('l-surl').textContent=T.statusUrl;",
    "$('t-cur').textContent=T.current;$('t-cli').textContent=T.fromThread;",
    "$('s-cli').textContent=T.place2+'\\nob-plugin-phone-agent-call --to \"+18195550123\" --mission \"…\"';",
    "function banner(id,k,t){var b=$(id);b.className='banner '+k;b.textContent=t;}",
    "function fmt(s){s=Math.max(0,Math.round(s||0));var m=Math.floor(s/60);return m+':'+(s%60<10?'0':'')+(s%60);}",
    "function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML;}",
    /* ---- nav ---- */
    "var current='calls';",
    "function show(sec){current=sec;",
    "  ['calls','missions','settings'].forEach(function(x){",
    "    $('sec-'+x).style.display=(x===sec)?'block':'none';",
    "    $('nav-'+x).className='navbtn'+((x===sec)?' on':'');});",
    "  try{location.hash=sec;}catch(e){}",
    "  if(sec==='missions')loadMissions();",
    "  if(sec==='settings')loadSettings();}",
    "$('nav-calls').onclick=function(){show('calls');};",
    "$('nav-missions').onclick=function(){show('missions');};",
    "$('nav-settings').onclick=function(){show('settings');};",
    "var h=(location.hash||'').replace('#','');show(['calls','missions','settings'].indexOf(h)>=0?h:'calls');",
    "window.addEventListener('hashchange',function(){var h2=(location.hash||'').replace('#','');if(['calls','missions','settings'].indexOf(h2)>=0&&h2!==current)show(h2);});",
    /* ---- calls ---- */
    "var activeSid='',beeped={};",
    "function beep(){try{var c=new (window.AudioContext||window.webkitAudioContext)();var o=c.createOscillator(),g=c.createGain();",
    "o.connect(g);g.connect(c.destination);o.frequency.value=880;g.gain.value=0.12;o.start();",
    "setTimeout(function(){o.stop();c.close();},350);}catch(e){}}",
    "function pill(t,c){var p=$('c-livepill');p.textContent=t;p.className='pill'+(c?' '+c:'');}",
    "function loadCalls(){fetch('api/status').then(function(r){return r.json()}).then(function(s){",
    "  if(s.ready){banner('c-banner','ok',T.ready);}else{banner('c-banner','setup',T.setup);}}).catch(function(){banner('c-banner','err',T.net);});",
    "  fetch('api/calls').then(function(r){return r.json()}).then(renderCalls).catch(function(){});}",
    "function renderCalls(j){",
    "  var calls=j.calls||[];",
    "  var act=calls.filter(function(c){return !c.endedAt&&c.status!=='completed'&&c.status!=='failed'&&c.status!=='no-answer'&&c.status!=='busy'&&c.status!=='canceled';});",
    "  var inc=act.filter(function(c){return c.direction==='in';});",
    "  if(inc.length){var c0=inc[0];",
    "    $('c-ring').style.display='block';$('c-ring').textContent=T.incoming+' '+T.from+' '+(c0.from||'')+' — '+T.answeredByAgent;",
    "    if(!beeped[c0.callSid]){beeped[c0.callSid]=1;beep();setTimeout(beep,1200);}}",
    "  else{$('c-ring').style.display='none';}",
    "  if(act.length){pill(act.length+' '+T.live,'live');var a=act[0];",
    "    if(a.callSid!==activeSid){activeSid=a.callSid;renderLive(a,false);}",
    "    fetch('api/calls?full='+encodeURIComponent(activeSid)).then(function(r){return r.json()}).then(function(d){if(d.call)renderLive(d.call,true);}).catch(function(){});}",
    "  else{activeSid='';$('c-livebox').innerHTML='';pill('—','');}",
    "  var tb=$('c-calls');tb.innerHTML='';var done=calls.filter(function(c){return c.endedAt;});",
    "  $('c-nocalls').style.display=done.length?'none':'block';",
    "  done.slice(0,15).forEach(function(c){var tr=document.createElement('tr');",
    "    var cells=[new Date(c.startedAt).toLocaleString(),c.direction==='in'?T.in:T.out,(c.direction==='in'?c.from:c.to)||'',",
    "    c.durationSec?fmt(c.durationSec):'—',c.status];",
    "    cells.forEach(function(v){var td=document.createElement('td');td.textContent=v;tr.appendChild(td);});tb.appendChild(tr);});",
    "}",
    "function renderLive(c,keep){",
    "  var box=$('c-livebox');var html='';",
    "  html+='<div class=row style=margin-bottom:8px><span class=\"dir '+(c.direction||'out')+'\">'+(c.direction==='in'?T.in:T.out)+'</span>' +",
    "    '<span class=pill '+(c.status==='in-progress'?'live':'ring')+'>'+(c.status||'')+'</span>' +",
    "    '<span>'+((c.direction==='in'?c.from:c.to)||'')+'</span><span style=flex:1></span><button class=danger id=c-hang>'+T.hangup+'</button></div>';",
    "  html+='<label>'+T.transcript+'</label><div id=c-log></div>';",
    "  html+='<div class=row style=margin-top:8px><input type=text id=c-whisper placeholder=\"'+T.whisperPh+'\"><button id=c-wh class=primary>'+T.whisperSend+'</button></div>';",
    "  if(!keep){box.innerHTML=html;$('c-hang').onclick=function(){fetch('api/hangup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callSid:c.callSid})}).then(loadCalls);};",
    "    $('c-wh').onclick=sendWhisper;$('c-whisper').onkeydown=function(e){if(e.key==='Enter')sendWhisper();};}",
    "  var log=$('c-log');if(!log)return;log.innerHTML='';var tr=c.transcript||[];",
    "  if(!tr.length){log.innerHTML='<div class=empty>…</div>';return;}",
    "  tr.forEach(function(t){var d=document.createElement('div');d.className='msg '+t.role;",
    "    var w=document.createElement('span');w.className='who';w.textContent=t.role==='agent'?T.agent:(t.role==='caller'?T.caller:T.you);",
    "    d.appendChild(w);var p=document.createElement('span');p.textContent=t.text;d.appendChild(p);log.appendChild(d);});",
    "  log.scrollTop=log.scrollHeight;}",
    "function sendWhisper(){var i=$('c-whisper');var v=i.value.trim();if(!v||!activeSid)return;",
    "  fetch('api/whisper',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callSid:activeSid,text:v})}).then(function(){i.value='';});}",
    /* ---- missions ---- */
    "$('m-place').onclick=function(){",
    "  var to=$('m-to').value.trim(),m=$('m-text').value.trim();if(!to||!m)return;",
    "  $('m-place').disabled=true;$('m-place').textContent=T.placing;$('m-msg').textContent='';",
    "  fetch('api/missions/place',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:to,mission:m})})",
    "  .then(function(r){return r.json()}).then(function(j){",
    "    $('m-place').disabled=false;$('m-place').textContent=T.place;",
    "    if(j.ok){$('m-to').value='';$('m-text').value='';$('m-msg').textContent=j.callSid||'';loadMissions();}",
    "    else{$('m-msg').textContent=(j.error||'error')+' — '+(j.hint||'');}})",
    "  .catch(function(){$('m-place').disabled=false;$('m-place').textContent=T.place;$('m-msg').textContent=T.net;});};",
    "function loadMissions(){fetch('api/status').then(function(r){return r.json()}).then(function(st){",
    "  if(st.ready){banner('m-banner','ok',T.ready);}else{banner('m-banner','setup',T.setup);}}).catch(function(){});",
    "  fetch('api/missions').then(function(r){return r.json()}).then(function(j){",
    "  var ms=(j.missions||[]).slice().reverse();",
    "  $('m-nom').style.display=ms.length?'none':'block';",
    "  var box=$('m-list');box.innerHTML='';",
    "  ms.forEach(function(m){var d=document.createElement('div');d.style.cssText='border-top:1px solid var(--line);padding:10px 0;';",
    "    var live=!m.endedAt;",
    "    d.innerHTML='<div class=row><span class=pill '+(live?'ring':'')+'>'+esc(m.status)+'</span><strong>'+esc(m.to)+'</strong>' +",
    "      '<span class=sub>'+new Date(m.createdAt).toLocaleString()+'</span></div>' +",
    "      '<div class=sub style=margin:4px 0>'+esc(m.mission).slice(0,300)+'</div>' +",
    "      (m.report?'<details><summary>'+T.report+'</summary><div class=sub style=white-space:pre-wrap>'+esc(m.report)+'</div></details>':'');",
    "    box.appendChild(d);});",
    "}).catch(function(){});}",
    /* ---- settings ---- */
    "function row(label,ok,val){var d=document.createElement('div');d.className='row';d.style.cssText='padding:6px 0;border-bottom:1px solid var(--line);justify-content:space-between';",
    "  var l=document.createElement('span');l.textContent=label;",
    "  var r=document.createElement('span');r.innerHTML='<span class='+(ok?'ok':'err')+'>'+(ok?T.set:T.missing)+'</span>'+(val?' <span class=sub>'+val+'</span>':'');",
    "  d.appendChild(l);d.appendChild(r);return d;}",
    "function loadSettings(){fetch('api/settings').then(function(r){return r.json()}).then(function(s){",
    "  var pn=s.phoneProvider==='signalwire'?T.signalwireName:T.twilioName;",
    "  $('t-hooks').textContent=T.webhooks.replace('{p}',pn);",
    "  $('t-hookhelp').textContent=T.webhookHelp.replace('{p}',pn);",
    "  var c=$('s-checks');c.innerHTML='';",
    "  c.appendChild(row(T.kxai,s.hasKey));",
    "  if(s.phoneProvider==='signalwire'){",
    "    c.appendChild(row(T.kswSpace,s.signalwire.space));",
    "    c.appendChild(row(T.kswProject,s.signalwire.project));",
    "    c.appendChild(row(T.kswToken,s.signalwire.token));",
    "    c.appendChild(row(T.kswPhone,s.signalwire.phone,s.signalwire.phone?('…'+String(s.signalwire.phone).slice(-4)):''));",
    "  }else{",
    "    c.appendChild(row(T.ksid,s.twilio.sid));",
    "    c.appendChild(row(T.ktok,s.twilio.token));",
    "    c.appendChild(row(T.kphone,s.twilio.phone,s.twilio.phone?('…'+String(s.twilio.phone).slice(-4)):''));",
    "  }",
    "  c.appendChild(row(T.kbase,s.publicBase));",
    "  if(s.ready){banner('s-banner','ok',T.ready);}else{banner('s-banner','setup',T.setup);}",
    "  var hook=s.phoneProvider==='signalwire'?'/signalwire/':'/twilio/';",
    "  if(s.publicBase){$('s-vurl').textContent=s.publicBase+hook+'voice';$('s-surl').textContent=s.publicBase+hook+'status';}",
    "  else{$('s-vurl').textContent='—';$('s-surl').textContent='—';}",
    "  var cu=$('s-cur');cu.innerHTML='';",
    "  [[T.phoneProvider,pn],[T.model,s.model],[T.voice,s.voice],[T.autoAnswer,s.autoAnswer?'on':'off']].forEach(function(p){",
    "    var d=document.createElement('div');d.className='row';d.style.cssText='padding:6px 0;border-bottom:1px solid var(--line);justify-content:space-between';",
    "    d.innerHTML='<span>'+p[0]+'</span><span class=sub>'+p[1]+'</span>';cu.appendChild(d);});",
    "}).catch(function(){banner('s-banner','err',T.net);});}",
    /* ---- loops ---- */
    "loadCalls();",
    "setInterval(function(){if(current==='calls')loadCalls();},2500);",
    "setInterval(function(){if(current==='missions')loadMissions();},3000);",
    "})();",
  ].join("\n");
}

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
      const ok = server.upgrade(req, {
        data: { callSid: url.searchParams.get("call") || undefined, query: url.search || "" },
      });
      return ok ? undefined : new Response("ws upgrade failed", { status: 400 });
    }

    /* dashboard pages (dashboard proxy prefixes get stripped by it; these are clean paths) */
    if (p === "/" || p === "/index.html" || p === "/missions" || p === "/settings") {
      // one merged app; in-app nav switches sections (hash: #calls #missions #settings)
      return new Response(appPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
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
