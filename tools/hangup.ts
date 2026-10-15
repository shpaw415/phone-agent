#!/usr/bin/env bun
/**
 * phone-agent — `ob-plugin-phone-agent-hangup`
 * Ends an active call.
 * Usage:
 *   ob-plugin-phone-agent-hangup                 (ends the single active call)
 *   ob-plugin-phone-agent-hangup --callsid CAxx  (ends that call)
 * Prints JSON: {ok, callSid} or {ok:false, error, hint}.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ID = "phone-agent";
const CFG_FILE = join(homedir(), ".config", "open-bot", `plugin-${ID}.json`);
const DATA_DIR = join(homedir(), ".open-bot", "pages-data", ID);

type Cfg = { settings?: Record<string, string>; vault?: Record<string, string> };
function cfg(): Cfg {
  try {
    return JSON.parse(readFileSync(CFG_FILE, "utf8")) as Cfg;
  } catch {
    return {};
  }
}
const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, "");
const s = cfg().settings ?? {};
const v = cfg().vault ?? {};
const twilioSid = clean(s.twilio_account_sid) || clean(v["phone-agent-twilio-sid"]);
const twilioToken = clean(s.twilio_auth_token) || clean(v["phone-agent-twilio-token"]);
const twilioBase = (s.twilio_base || "https://api.twilio.com").trim().replace(/\/+$/, "");

/* SignalWire (Compatibility API: Twilio-shaped REST under /api/laml). */
const swSpace = (s.signalwire_space || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\.signalwire\.com.*$/i, "")
  .replace(/\/+$/, "");
const swProject = clean(s.signalwire_project) || clean(v["phone-agent-signalwire-project"]);
const swToken = clean(s.signalwire_token) || clean(v["phone-agent-signalwire-token"]);
const PROVIDER = (s.phone_provider || "twilio").trim() === "signalwire" ? "signalwire" : "twilio";
const tel =
  PROVIDER === "signalwire"
    ? {
        sid: swProject,
        token: swToken,
        base: (s.signalwire_base || (swSpace ? `https://${swSpace}.signalwire.com/api/laml` : "")).trim().replace(/\/+$/, ""),
      }
    : { sid: twilioSid, token: twilioToken, base: twilioBase };

function fail(error: string, hint: string): never {
  console.log(JSON.stringify({ ok: false, error, hint }, null, 1));
  process.exit(1);
}

type Call = { callSid?: string; status?: string; ended?: boolean; missionId?: string; [k: string]: unknown };
type Mission = { id: string; status: string; callSid?: string; endedAt?: string; report?: string; [k: string]: unknown };
function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(`${DATA_DIR}/${file}`, "utf8")) as T;
  } catch {
    return fallback;
  }
}

const calls = readJson<Call[]>("calls.json", []);
const missions = readJson<Mission[]>("missions.json", []);

const i = process.argv.indexOf("--callsid");
let callSid = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";

if (!callSid) {
  const active = calls.filter((c) => c.callSid && !c.ended && c.status !== "completed" && c.status !== "failed");
  if (active.length === 0) fail("no_active_call", "No active call right now. Pass one with --callsid CAxxxx.");
  if (active.length > 1)
    fail("many_active", "Several calls are active: " + active.map((c) => c.callSid).join(", ") + " — pick one with --callsid.");
  callSid = String(active[0].callSid);
}

if (!tel.sid || !tel.token)
  fail(
    "no_provider_creds",
    PROVIDER === "signalwire"
      ? "SignalWire Project ID/API token missing (Plugins → Phone Agent → Settings, or vault slugs phone-agent-signalwire-project / phone-agent-signalwire-token)."
      : "Twilio SID/token missing (Plugins → Phone Agent → Settings)."
  );

let status = 0;
let body = "";
try {
  const res = await fetch(`${tel.base}/2010-04-01/Accounts/${tel.sid}/Calls/${encodeURIComponent(callSid)}.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${tel.sid}:${tel.token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ Status: "completed" }).toString(),
  });
  status = res.status;
  body = await res.text();
} catch (e) {
  fail("network", "Could not reach the provider API: " + String(e).slice(0, 160));
}

if (status < 200 || status >= 300) fail("provider_error", "The provider refused (" + status + "): " + body.slice(0, 200));

/* local bookkeeping: mark ended, mission canceled */
for (const c of calls) {
  if (c.callSid === callSid && !c.ended) {
    c.ended = true;
    c.status = "completed";
    c.endedBy = "tool";
    c.endedAt = new Date().toISOString();
  }
}
if (existsSync(`${DATA_DIR}/calls.json`)) writeFileSync(`${DATA_DIR}/calls.json`, JSON.stringify(calls.slice(-500), null, 1));

const m = missions.find((x) => x.callSid === callSid && !x.endedAt);
if (m) {
  m.status = "canceled";
  m.endedAt = new Date().toISOString();
  m.report = (m.report ? m.report + "\n" : "") + "The call was ended early by request.";
  writeFileSync(`${DATA_DIR}/missions.json`, JSON.stringify(missions.slice(-500), null, 1));
}

console.log(JSON.stringify({ ok: true, callSid, status: "completed" }, null, 1));
