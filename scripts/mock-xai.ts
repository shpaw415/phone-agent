#!/usr/bin/env bun
/**
 * phone-agent — mock xAI realtime for local stress tests. NOT installed.
 *
 * Mimics enough of the xAI realtime API to exercise the media bridge without
 * x.ai, and DETERMINISTICALLY replays the transient failure seen in testing:
 * the FIRST WebSocket connection is closed immediately, so the plugin must
 * re-mint a client secret and reconnect (resilience path). Later connections
 * behave like a minimal voice agent: it transcribes, speaks a short line, then
 * calls hang_up_call so the test call ends on its own.
 *
 * Usage: bun scripts/mock-xai.ts [port]
 * Point the plugin at it: ob-plugin settings phone-agent gateway_base=http://127.0.0.1:4091
 */

const PORT = Number(process.argv[2] ?? 4091);
let mints = 0;
let attempts = 0;

function log(...a: unknown[]) {
  console.log("[mock-xai]", ...a);
}

/* pcm16 24 kHz b64 tone (300 ms of 440 Hz) */
function tone(): string {
  const n = Math.floor(24000 * 0.3);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 9000);
  return Buffer.from(pcm.buffer, 0, pcm.byteLength).toString("base64");
}

/* websocket side */
const sockets = new Map<any, { fired: boolean }>();

Bun.serve({
  port: PORT,
  websocket: {
    open(ws) {
      attempts++;
      log("WS attempt #", attempts);
      sockets.set(ws, { fired: false });
      if (attempts === 1) {
        log("attempt 1: simulating transient death (immediate close)");
        setTimeout(() => {
          try {
            ws.close(1000, "simulated transient failure");
          } catch {}
        }, 120);
      }
    },
    message(ws, raw) {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const t = String(m.type || "");
      const st = sockets.get(ws);
      if (!st || st.fired) return;
      if (t === "session.update") {
        log("session.update accepted");
        return;
      }
      if (t === "input_audio_buffer.append") {
        st.fired = true; // one scripted turn per session
        const say = (obj: unknown, delay: number) =>
          setTimeout(() => {
            try {
              ws.send(JSON.stringify(obj));
            } catch {}
          }, delay);
        say({ type: "conversation.item.input_audio_transcription.completed", transcript: "Hello? Who is this?" }, 60);
        say({ type: "response.output_audio_transcript.delta", delta: "Hi! This is the mock agent speaking. " }, 120);
        say({ type: "response.output_audio_transcript.delta", delta: "Everything works, goodbye!" }, 140);
        for (let i = 0; i < 6; i++) say({ type: "response.output_audio.delta", delta: tone() }, 200 + i * 120);
        say({ type: "response.done" }, 1100);
        say(
          {
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "mock-call-1", name: "hang_up_call", arguments: "{}" },
          },
          1200,
        );
      }
    },
    close(ws) {
      sockets.delete(ws);
      log("WS closed");
    },
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/realtime") {
      const ok = server.upgrade(req);
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (req.method === "POST" && url.pathname === "/v1/realtime/client_secrets") {
      await req.text();
      mints++;
      log("client_secrets mint #", mints);
      return Response.json({
        value: "mock-secret-" + mints,
        expires_at: new Date(Date.now() + 300000).toISOString(),
      });
    }
    if (url.pathname === "/healthz") return new Response("ok");
    return new Response("mock-xai: not found " + url.pathname, { status: 404 });
  },
});

log(`mock xAI (HTTP mint + realtime WS) on http://127.0.0.1:${PORT}`);
