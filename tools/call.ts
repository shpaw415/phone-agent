#!/usr/bin/env bun
/**
 * phone-agent — `ob-plugin-phone-agent-call`
 * Places a phone call with a mission for the speech-to-speech agent.
 *
 * Usage:
 *   ob-plugin-phone-agent-call --to "+18195550123" --mission "Call X. Order delivery for 6 PM."
 * Options:
 *   --to <E164>        required, + and country code
 *   --mission <text>   required, self-contained instructions in the callee's language
 *   --from <E164>      optional override of the provider caller number
 * Prints JSON: {ok, missionId, callSid, provider} or {ok:false, error, hint}.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const twilioPhone = (clean(s.twilio_phone) || clean(v["phone-agent-twilio-phone"])).replace(/\s+/g, "");
const twilioBase = (s.twilio_base || "https://api.twilio.com").trim().replace(/\/+$/, "");

/* SignalWire (Compatibility API: Twilio-shaped REST under /api/laml). */
const swSpace = (s.signalwire_space || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\.signalwire\.com.*$/i, "")
  .replace(/\/+$/, "");
const swProject = clean(s.signalwire_project) || clean(v["phone-agent-signalwire-project"]);
const swToken = clean(s.signalwire_token) || clean(v["phone-agent-signalwire-token"]);
const swPhone = (clean(s.signalwire_phone) || clean(v["phone-agent-signalwire-phone"])).replace(/\s+/g, "");
const swBase = (s.signalwire_base || (swSpace ? `https://${swSpace}.signalwire.com/api/laml` : ""))
  .trim()
  .replace(/\/+$/, "");

const PROVIDER = (s.phone_provider || "twilio").trim() === "signalwire" ? "signalwire" : "twilio";
const PNAME = PROVIDER === "signalwire" ? "SignalWire" : "Twilio";
const tel =
  PROVIDER === "signalwire"
    ? { sid: swProject, token: swToken, phone: swPhone, base: swBase, hook: "signalwire" }
    : { sid: twilioSid, token: twilioToken, phone: twilioPhone, base: twilioBase, hook: "twilio" };

const publicBase = (s.public_base || "").trim().replace(/\/+$/, "");

function fail(error: string, hint: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ ok: false, error, hint, ...extra }, null, 1));
  process.exit(1);
}

function arg(name: string): string {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

const to = arg("to");
const mission = arg("mission").trim();
const from = arg("from") || tel.phone;

if (!to || !mission) fail("bad_args", "Usage: ob-plugin-phone-agent-call --to \"+18195550123\" --mission \"...\"");
if (!/^\+[1-9]\d{7,14}$/.test(to)) fail("bad_number", "The --to number must be E.164: + and country code, e.g. +18195550123.");
if (!tel.sid || !tel.token)
  fail(
    "no_provider_creds",
    PROVIDER === "signalwire"
      ? "SignalWire Project ID/API token missing. Dashboard → Plugins → Phone Agent → Settings, or vault slugs phone-agent-signalwire-project / phone-agent-signalwire-token (signalwire_space must be set too)."
      : "Twilio SID/token missing. Dashboard → Plugins → Phone Agent → Settings, or vault slugs phone-agent-twilio-sid / phone-agent-twilio-token.",
  );
if (!tel.phone)
  fail(
    "no_number",
    PROVIDER === "signalwire"
      ? "No SignalWire phone number configured (settings signalwire_phone or vault slug phone-agent-signalwire-phone)."
      : "No Twilio phone number configured (settings twilio_phone or vault slug phone-agent-twilio-phone).",
  );
if (PROVIDER === "signalwire" && !tel.base)
  fail("no_sw_base", "signalwire_space is not set (the xxx of xxx.signalwire.com) — needed to reach the SignalWire API.");
if (!publicBase) fail("no_public", "public_base is not set: the Config page → Endpoints tab URL for this plugin (the provider must reach it).");

/* mission store (same files as the page server) */
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
function readMissions(): Mission[] {
  try {
    return JSON.parse(readFileSync(`${DATA_DIR}/missions.json`, "utf8")) as Mission[];
  } catch {
    return [];
  }
}
function saveMissions(list: Mission[]) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${DATA_DIR}/missions.json`, JSON.stringify(list.slice(-500), null, 1));
}

const missionId = crypto.randomUUID().slice(0, 8);
const missions = readMissions();
missions.push({ id: missionId, to, mission, status: "queued", createdAt: new Date().toISOString() });
saveMissions(missions);

/* place the call through the active provider */
const hookBase = `${publicBase}/${tel.hook}`;
const webhook = `${hookBase}/outbound?mission=${encodeURIComponent(missionId)}`;
const params = new URLSearchParams({
  To: to,
  From: from,
  Url: webhook,
  Method: "POST",
  StatusCallback: `${hookBase}/status?mission=${encodeURIComponent(missionId)}`,
  StatusCallbackMethod: "POST",
  Timeout: "45",
});

let status = 0;
let body = "";
try {
  const res = await fetch(`${tel.base}/2010-04-01/Accounts/${tel.sid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${tel.sid}:${tel.token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  status = res.status;
  body = await res.text();
} catch (e) {
  fail("network", `Could not reach the ${PNAME} API: ` + String(e).slice(0, 160));
}

let j: any = body;
try {
  j = JSON.parse(body);
} catch {}

if (status < 200 || status >= 300) {
  const list = readMissions();
  const m = list.find((x) => x.id === missionId);
  if (m) {
    m.status = "failed";
    m.endedAt = new Date().toISOString();
    m.report = PNAME + " rejected the call (" + status + "): " + String(j?.message ?? body).slice(0, 300);
    saveMissions(list);
  }
  fail("provider_error", String(j?.message ?? body).slice(0, 300) + " (code " + (j?.code ?? status) + ")", { missionId, provider: PROVIDER });
}

const callSid = String(j?.sid ?? "");
{
  const list = readMissions();
  const m = list.find((x) => x.id === missionId);
  if (m) {
    m.callSid = callSid;
    m.status = "ringing";
    saveMissions(list);
  }
}

console.log(JSON.stringify({ ok: true, missionId, callSid, to, status: "queued", provider: PROVIDER }, null, 1));
