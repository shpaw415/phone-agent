#!/usr/bin/env bun
/**
 * phone-agent — `ob-plugin-phone-agent-status`
 * Prints a readiness/status JSON for the plugin. Never prints any secret value.
 * Usage: ob-plugin-phone-agent-status [--last-report] [--json-always]
 */
import { readFileSync } from "node:fs";
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

/** Shared key entry can be a plain string or a {apiKey,…} object. */
function keyFromShared(entry: unknown): string {
  if (entry && typeof entry === "object") {
    const o = entry as Record<string, unknown>;
    return clean(o.apiKey ?? o.key ?? o.token ?? "");
  }
  const str = clean(entry);
  if (str.startsWith("{")) {
    try {
      const o = JSON.parse(str) as Record<string, unknown>;
      return clean(o.apiKey ?? o.key ?? o.token ?? "");
    } catch {
      return "";
    }
  }
  return str;
}

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
const PROVIDER = (s.phone_provider || "twilio").trim() === "signalwire" ? "signalwire" : "twilio";
const tel =
  PROVIDER === "signalwire"
    ? {
        sid: swProject,
        token: swToken,
        phone: swPhone,
        base: (s.signalwire_base || (swSpace ? `https://${swSpace}.signalwire.com/api/laml` : "")).trim().replace(/\/+$/, ""),
      }
    : { sid: twilioSid, token: twilioToken, phone: twilioPhone, base: twilioBase };
const xai = clean(s.xai_api_key) || clean(v["xai-api-key"]) || keyFromShared(v["xai"]);
const xaiSource = clean(s.xai_api_key)
  ? "settings"
  : clean(v["xai-api-key"])
    ? "vault"
    : keyFromShared(v["xai"])
      ? "shared:xai"
      : "";

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(`${DATA_DIR}/${file}`, "utf8")) as T;
  } catch {
    return fallback;
  }
}
type Call = { callSid?: string; status?: string; direction?: string; ended?: boolean; [k: string]: unknown };
type Mission = { id: string; status: string; report?: string; endedAt?: string; [k: string]: unknown };

const calls = readJson<Call[]>("calls.json", []);
const missions = readJson<Mission[]>("missions.json", []);
const active = calls.filter((c) => !c.ended && c.status !== "completed" && c.status !== "failed");

const missing: string[] = [];
if (!xai) missing.push("xAI API key");
if (PROVIDER === "signalwire") {
  if (!swSpace) missing.push("SignalWire Space name");
  if (!swProject || !swToken) missing.push("SignalWire Project ID + API token");
  if (!swPhone) missing.push("SignalWire phone number");
} else {
  if (!twilioSid || !twilioToken) missing.push("Twilio Account SID + Auth Token");
  if (!twilioPhone) missing.push("Twilio phone number");
}
const publicBase = (s.public_base || "").trim().replace(/\/+$/, "");
if (!publicBase) missing.push("public_base (Endpoints URL)");

const out: Record<string, unknown> = {
  plugin: ID,
  hasKey: Boolean(xai),
  keySource: xaiSource,
  phoneProvider: PROVIDER,
  tel: { sid: Boolean(tel.sid), token: Boolean(tel.token), phone: tel.phone || false },
  twilio: { sid: Boolean(twilioSid), token: Boolean(twilioToken), phone: twilioPhone || false },
  signalwire: { space: swSpace || false, project: Boolean(swProject), token: Boolean(swToken), phone: swPhone || false },
  publicBase: publicBase || false,
  twilioBase,
  signalwireBase: tel.base || false,
  autoAnswer: (s.auto_answer ?? "true") === "true",
  verify: PROVIDER === "signalwire" ? (s.signalwire_verify ?? "false") === "true" : (s.twilio_verify ?? "false") === "true",
  model: (s.model || "grok-voice-latest").trim(),
  voice: (s.voice || "eve").trim(),
  activeCalls: active.map((c) => ({ callSid: c.callSid, direction: c.direction, status: c.status })),
  missionsTotal: missions.length,
};

const wantReport = process.argv.includes("--last-report");
if (wantReport) {
  const done = missions.filter((m) => m.endedAt).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
  out.lastReport = done[0] ?? null;
}

const ready = missing.length === 0;
out.ready = ready;
out.hint = ready
  ? "Ready. Place a call: ob-plugin-phone-agent-call --to \"+1...\" --mission \"...\""
  : "Setup missing: " + missing.join(", ") + ". Dashboard → Plugins → Phone Agent → Settings (or vault slugs).";
console.log(JSON.stringify(out, null, wantReport ? 2 : 1));
