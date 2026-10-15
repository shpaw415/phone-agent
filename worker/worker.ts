#!/usr/bin/env bun
/**
 * phone-agent — `ob-plugin-phone-agent-mission-worker`
 * Detached helper, spawned by the page server (never run by hand).
 *
 * Modes:
 *   delegate <id>     run one opencode task for a live call, write delegate-result-<id>.json
 *   thread   <id>     start a background open-bot thread (thread-task-<id>.json), fire and forget
 *   report   <callSid> finalize the mission report of a finished call + notify
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ID = "phone-agent";
const DATA_DIR = join(homedir(), ".open-bot", "pages-data", ID);
const CFG_FILE = join(homedir(), ".config", "open-bot", `plugin-${ID}.json`);

type Cfg = { settings?: Record<string, string> };
let s: Record<string, string> = {};
try {
  s = (JSON.parse(readFileSync(CFG_FILE, "utf8")) as Cfg).settings ?? {};
} catch {}
const agent = (s.delegate_agent || "").trim();
const timeoutSec = Math.min(600, Math.max(30, Number(s.delegate_timeout ?? 240) || 240));

const mode = process.argv[2] || "";
const id = process.argv[3] || "";

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(`${DATA_DIR}/${file}`, "utf8")) as T;
  } catch {
    return null;
  }
}

/* ---------------- delegate ---------------- */

if (mode === "delegate") {
  const task = String(readJson<{ task?: string }>(`delegate-task-${id}.json`)?.task ?? "");
  const done = (result: string) =>
    writeFileSync(`${DATA_DIR}/delegate-result-${id}.json`, JSON.stringify({ result: String(result).slice(0, 4000) }));

  if (!task) {
    done("No task was provided.");
    process.exit(0);
  }
  try {
    const proc = Bun.spawn(["opencode", "run", ...(agent ? ["--agent", agent] : []), task], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: join(homedir(), "workspace"),
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill();
      } catch {}
    }, timeoutSec * 1000);
    const parts = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    let result = parts[0].trim();
    if (!result) result = killed ? "The task did not finish in time." : "(empty response)";
    await done(result);
  } catch (e) {
    await done("Delegation failed: " + String(e).slice(0, 120));
  }
  try {
    unlinkSync(`${DATA_DIR}/delegate-task-${id}.json`);
  } catch {}
  process.exit(0);
}

/* ---------------- thread ---------------- */

if (mode === "thread") {
  const topic = String(readJson<{ topic?: string }>(`thread-task-${id}.json`)?.topic ?? "");
  if (!topic) process.exit(0);
  const prompt =
    `You are following up a phone call for the user (phone-agent plugin). Topic from the call: ${topic}\n` +
    `Work on it now, keep the thread self-contained, and when you are done, add one clear summary line for the user.`;
  try {
    Bun.spawn(["setsid", "opencode", "run", "--title", "worker: " + topic.slice(0, 60), ...(agent ? ["--agent", agent] : []), prompt], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      cwd: join(homedir(), "workspace"),
    });
  } catch {
    try {
      Bun.spawn(["opencode", "run", "--title", "worker: " + topic.slice(0, 60), prompt], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        cwd: join(homedir(), "workspace"),
      });
    } catch {}
  }
  try {
    unlinkSync(`${DATA_DIR}/thread-task-${id}.json`);
  } catch {}
  process.exit(0);
}

/* ---------------- report ---------------- */

if (mode === "report") {
  type Turn = { role: string; text: string; ts?: string };
  type Call = {
    callSid?: string;
    direction?: string;
    from?: string;
    to?: string;
    status?: string;
    missionId?: string;
    durationSec?: number;
    transcript?: Turn[];
    endedAt?: string;
    error?: string;
  };
  const call = readJson<Call>(`call-${id}.json`);
  const missions = readJson<any[]>("missions.json") ?? [];
  if (!call) process.exit(0);

  const answered = Number(call.durationSec ?? 0) >= 5;
  let status = answered ? "done" : call.status === "failed" ? "failed" : "no_answer";
  const transcript = call.transcript ?? [];
  const lastAgent = [...transcript].reverse().find((t) => t.role === "agent" && t.text.trim());

  let report: string;
  if (call.direction === "in") {
    report =
      `Incoming call from ${call.from ?? "unknown"} — ${answered ? "answered" : "not answered"}` +
      (call.durationSec ? `, ${Math.floor(Number(call.durationSec) / 60)}:${String(Number(call.durationSec) % 60).padStart(2, "0")}` : "") +
      ".\n";
  } else {
    report = `Call to ${call.to ?? "unknown"} — ${answered ? "connected" : status === "failed" ? "failed" : "no answer"}` +
      (call.durationSec ? `, ${Math.floor(Number(call.durationSec) / 60)}:${String(Number(call.durationSec) % 60).padStart(2, "0")}` : "") +
      ".\n";
  }
  if (lastAgent) report += "Agent summary: " + lastAgent.text.trim().slice(0, 1500);
  else if (!answered) report += "No conversation happened.";
  if (call.error) report += "\nTechnical note: " + String(call.error).slice(0, 300);

  if (call.missionId) {
    const m = missions.find((x: any) => x.id === call.missionId);
    if (m && !m.endedAt) {
      m.status = status;
      m.endedAt = call.endedAt || new Date().toISOString();
      m.report = report;
      try {
        writeFileSync(`${DATA_DIR}/missions.json`, JSON.stringify(missions.slice(-500), null, 1));
      } catch {}
    }
  }
  try {
    Bun.spawn(["ob-plugin", "notify", ID, "Phone agent", report.slice(0, 180)], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  process.exit(0);
}

process.exit(0);
