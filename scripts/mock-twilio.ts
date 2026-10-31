#!/usr/bin/env bun
/**
 * phone-agent — mock Twilio for local stress tests. NOT installed.
 *
 * Mimics enough of Twilio to exercise the plugin end to end without a real
 * Twilio account:
 *   - REST API (POST Calls.json, POST Calls/<sid>.json) on MOCK_PORT (default 4090)
 *   - fires the plugin webhooks (Url / StatusCallback from the request)
 *   - plays the remote caller: opens the media WebSocket, sends speech-shaped
 *     audio (440 Hz bursts), logs the agent audio that comes back.
 *
 * Usage: bun scripts/mock-twilio.ts [port]
 * Point the plugin at it: ob-plugin settings phone-agent twilio_base=http://127.0.0.1:4090
 * and public_base=http://127.0.0.1:<page server port>
 */
import { createServer } from "node:http";
import { createHmac } from "node:crypto";

const PORT = Number(process.argv[2] ?? 4090);
// Match the synthetic Auth Token in an isolated test configuration.
const AUTH_TOKEN = process.env.MOCK_AUTH_TOKEN || "synthetic-signing-secret";

/* ---- mulaw encode (8k) + speech-shaped caller audio ---- */
function pcmToMulaw(pcm: Int16Array): Buffer {
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
  return out;
}

/** Synthesize a spoken utterance: espeak-ng → 8 kHz mulaw chunks (20 ms each).
 *  Returns [] if espeak-ng is unavailable. */
function speak(text: string): string[] {
  try {
    const wav = `/tmp/opencode/mock-caller.wav`;
    Bun.spawnSync(["espeak-ng", "-v", "en-US", "-s", "145", "-w", wav, text]);
    const data = require("node:fs").readFileSync(wav);
    // parse minimal WAV header
    if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF") return [];
    const rate = data.readUInt32LE(24);
    const bits = data.readUInt16LE(34);
    const channels = data.readUInt16LE(22);
    if (bits !== 16 || channels !== 1) return [];
    const pcmStart = 44;
    const n = (data.length - pcmStart) >> 1;
    // resample to 8 kHz (linear)
    const outLen = Math.floor((n * 8000) / rate);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const t = (i * rate) / 8000;
      const i0 = Math.floor(t);
      const fr = t - i0;
      const a = data.readInt16LE(pcmStart + i0 * 2);
      const b = i0 + 1 < n ? data.readInt16LE(pcmStart + (i0 + 1) * 2) : a;
      pcm[i] = Math.round(a + (b - a) * fr);
    }
    const mulaw = pcmToMulaw(pcm);
    const chunks: string[] = [];
    for (let off = 0; off < mulaw.length; off += 160) chunks.push(mulaw.subarray(off, off + 160).toString("base64"));
    return chunks;
  } catch {
    return [];
  }
}

/* ---- active simulated calls ---- */
type SimCall = {
  sid: string;
  to: string;
  from: string;
  webhookUrl: string;
  streamUrl?: string;
  streamToken?: string;
  statusCb: string;
  ws?: WebSocket;
  startedAt: number;
  speakTimer?: ReturnType<typeof setInterval>;
  markTimer?: ReturnType<typeof setInterval>;
  gotAudio: number;
  gotAgentText: number;
  hangupBy?: string;
};
const calls = new Map<string, SimCall>();

function log(...a: unknown[]) {
  console.log("[mock-twilio]", ...a);
}

async function postForm(url: string, params: Record<string, string>) {
  try {
    const data = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": createHmac("sha1", AUTH_TOKEN).update(data).digest("base64") },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    log("webhook →", res.status, new URL(url).pathname);
    return text;
  } catch (e) {
    log("webhook FAILED", url.slice(0, 120), String(e).slice(0, 120));
    return "";
  }
}

/** Connect the simulated caller to the plugin media WS and speak. */
function connectCaller(c: SimCall) {
  if (!c.streamUrl || !c.streamToken) { log("no authenticated Stream returned"); return; }
  // Forward the webhook query (mission=…) like Twilio customParameters would.
  const u = new URL(c.webhookUrl);
  const q = new URLSearchParams(u.search);
  q.set("call", c.sid);
  q.set("dir", "out");
  q.set("to", c.to);
  q.set("from", c.from);
  q.set("t", c.streamToken);
  const wsUrl = c.streamUrl.replace(/^http/i, "ws").split("?")[0];
  log("caller WS →", new URL(wsUrl).pathname);
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    log("caller WS failed:", String(e).slice(0, 120));
    return;
  }
  c.ws = ws;
  let streamSid = "MS" + Math.random().toString(36).slice(2, 10);
  let chunk = 0;
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        start: {
          streamSid,
          accountSid: "ACmock",
          callSid: c.sid,
          tracks: ["inbound"],
          customParameters: Object.fromEntries(q.entries()),
        },
        streamSid,
      }),
    );
    log("caller: stream started");
    // the scripted "callee": a restaurant answering, then taking the order, then goodbye
    const lines = [
      "Hello, thank you for calling Pizza Palace. How can I help you today?",
      "Sure! One large pepperoni pizza for pickup at six PM. That will be eighteen fifty.",
      "Perfect, one large pepperoni at six PM. See you then. Bye bye!",
    ];
    let li = 0;
    let chunk = 0;
    let seq = 100;
    const sayLine = () => {
      if (li >= lines.length || ws.readyState !== 1) {
        if (c.speakTimer) clearInterval(c.speakTimer);
        return;
      }
      const chunks = speak(lines[li++]);
      if (!chunks.length) {
        log("caller: espeak unavailable — no speech");
        if (c.speakTimer) clearInterval(c.speakTimer);
        return;
      }
      log(`caller: line ${li} (${chunks.length} chunks)`);
      chunks.forEach((payload, i) => {
        setTimeout(() => {
          if (ws.readyState === 1)
            ws.send(
              JSON.stringify({
                event: "media",
                sequenceNumber: String(++seq),
                media: { track: "inbound", chunk: String(++chunk), timestamp: String(i * 20), payload },
              }),
            );
        }, i * 20);
      });
    };
    sayLine();
    c.speakTimer = setInterval(sayLine, 14000);
  });
  ws.addEventListener("message", (ev) => {
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.event === "media") {
      c.gotAudio++;
      if (c.gotAudio === 1) log("caller: FIRST agent audio received ✓");
    } else if (m.event === "mark") {
      // ignore
    }
  });
  ws.addEventListener("close", () => log("caller: WS closed. agent audio chunks:", c.gotAudio));
  ws.addEventListener("error", () => log("caller: WS error"));
}

function completeCall(c: SimCall, status: string) {
  if (c.speakTimer) clearInterval(c.speakTimer);
  try {
    c.ws?.close();
  } catch {}
  const dur = Math.round((Date.now() - c.startedAt) / 1000);
  setTimeout(() => {
    postForm(c.statusCb, {
      CallSid: c.sid,
      CallStatus: status,
      CallDuration: String(dur),
      From: c.from,
      To: c.to,
    });
  }, 400);
}

/* ---- fake REST API ---- */

function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d: Buffer) => (b += d));
    req.on("end", () => resolve(b));
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;
  if (req.method === "GET" && (p === "/healthz" || p === "/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mock: "twilio", activeCalls: calls.size }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const body = await readBody(req);
  const params: Record<string, string> = {};
  new URLSearchParams(body).forEach((v, k) => (params[k] = v));

  if (p.endsWith("/Calls.json")) {
    const sid = "CA" + Math.random().toString(36).slice(2, 12);
    const c: SimCall = {
      sid,
      to: params.To || "+15550000000",
      from: params.From || "+15551111111",
      webhookUrl: params.Url || "",
      statusCb: params.StatusCallback || "",
      startedAt: Date.now(),
      gotAudio: 0,
      gotAgentText: 0,
    };
    calls.set(sid, c);
    log("POST Calls.json →", sid, "to", c.to, "webhook", c.webhookUrl.slice(0, 80));
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ sid, status: "queued", to: c.to, from: c.from }));
    // ring ~700 ms, then answer and fire the answer webhook
    setTimeout(async () => {
      const xml = await postForm(c.webhookUrl, {
        CallSid: sid,
        CallStatus: "in-progress",
        From: c.from,
        To: c.to,
        Called: c.to,
        Caller: c.from,
      });
      c.streamUrl = xml.match(/<Stream url="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
      c.streamToken = xml.match(/<Parameter name="t" value="([a-f0-9]+)"/)?.[1];
      connectCaller(c);
    }, 700);
    return;
  }

  const mHangup = p.match(/\/Calls\/(CA[^/]+)\.json$/);
  if (mHangup) {
    const c = calls.get(mHangup[1]);
    log("POST hangup for", mHangup[1], c ? "(known)" : "(unknown)");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sid: mHangup[1], status: params.Status || "completed" }));
    if (c && !c.hangupBy) {
      c.hangupBy = "rest";
      completeCall(c, "completed");
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 404, message: "mock: not found " + p }));
}).listen(PORT, () => log(`mock Twilio REST on http://127.0.0.1:${PORT}`));

/* auto-complete calls after 90 s so tests never leak */
setInterval(() => {
  for (const c of calls.values()) {
    if (!c.hangupBy && Date.now() - c.startedAt > 90_000) {
      log("auto-completing", c.sid);
      c.hangupBy = "timeout";
      completeCall(c, "completed");
    }
  }
}, 5000);
