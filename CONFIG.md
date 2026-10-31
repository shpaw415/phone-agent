# Configuring phone-agent with the user

You are configuring the `phone-agent` open-bot plugin on this desktop for the user.
Walk them through it step by step. Never print or echo secret values; fill
them with the write-only commands shown here.

## What this plugin needs

The plugin makes and answers **real phone calls** with a speech-to-speech agent
(xAI Grok Voice bridged over a telephony provider: Twilio by default, or
SignalWire with `phone_provider=signalwire`). Before it can place or take a call
it needs: an **xAI API key** (usually already covered by the shared key on the
Config page), a **telephony account** on the active provider (credentials + one
purchased phone number), and a **public endpoint URL** so the provider can reach
this desktop. Until all pieces are set, `ob-plugin-phone-agent-status` reports
what is missing.

## Settings

Change with `ob-plugin settings phone-agent KEY=value` (or the Plugins page).

| key | type | default | what to ask the user |
| --- | ---- | ------- | -------------------- |
| public_base | string | (empty) | Copy the Endpoints URL for this plugin from the web Config page → Endpoints tab (looks like `https://…/hooks/phone-agent`). The provider must reach it. |
| phone_provider | enum | twilio | Which telephony provider places the calls: `twilio` or `signalwire`. |
| model | string | grok-voice-latest | Usually keep the default realtime model. |
| voice | string | eve | Voice name supported by the provider (eve, ara, …). |
| instructions | string | (built-in prompt) | Optional extra standing rules for the agent on calls. |
| capabilities | string | (built-in list) | What the open-bot desktop may be asked to do from a call (told to the phone agent). |
| delegate_agent | string | (empty) | Only if they want delegation to run with a specific opencode agent. |
| delegate_timeout | number | 240 | Seconds a delegated desktop task may take during a call. |
| auto_answer | bool | true | Whether incoming calls to the provider number are answered by the agent. Off = polite decline. |
| twilio_verify | bool | true | Legacy setting; signatures are always enforced, even if an older install saved false. |
| twilio_base | string | https://api.twilio.com | Leave empty except for tests against a mock. |
| twilio_account_sid | secret | (empty) | Twilio console → Account Info. |
| twilio_auth_token | secret | (empty) | Twilio console → Auth Token. |
| twilio_phone | string | (empty) | The Twilio number to call from and listen on, E.164 (`+1…`). |
| signalwire_space | string | (empty) | The Space name (the `xxx` of `xxx.signalwire.com`). |
| signalwire_project | secret | (empty) | SignalWire Dashboard → API Credentials → Project ID. |
| signalwire_token | secret | (empty) | SignalWire API token (needs the **Voice** scope). |
| signalwire_phone | string | (empty) | The SignalWire number to call from and listen on, E.164 (`+1…`). |
| signalwire_signing_key | secret | (empty) | SignalWire Dashboard → API Credentials → Signing Key (only for webhook verification). |
| signalwire_verify | bool | true | Legacy setting; signatures are always enforced. Supply the SignalWire Signing Key. |
| signalwire_base | string | (empty) | Blank = `https://SPACE.signalwire.com/api/laml`. Override for tests only. |
| xai_api_key | secret | (empty) | Only if the shared xAI key is not on the Config page. |

## Vault keys

Fill with `ob-plugin vault phone-agent SLUG=value` (write-only; never echo the value).
The user can also set them on the dashboard: Plugins tab → Settings →
Vault keys (the agent never sees the values either way).

Twilio (active when `phone_provider=twilio`):

- `phone-agent-twilio-sid` — Twilio Account SID (alternative to the secret setting).
- `phone-agent-twilio-token` — Twilio Auth Token.
- `phone-agent-twilio-phone` — the Twilio phone number.

SignalWire (active when `phone_provider=signalwire`):

- `phone-agent-signalwire-project` — Project ID (alternative to the secret setting).
- `phone-agent-signalwire-token` — API token.
- `phone-agent-signalwire-phone` — the SignalWire phone number.
- `phone-agent-signalwire-signing-key` — signing key, for webhook verification.

Either provider:

- `xai-api-key` — xAI key; the shared `xai` slug on the Config page Keys tab is read
  automatically if this one is empty.

## Walkthrough

1. Check what is missing: `ob-plugin-phone-agent-status`.
2. Shared xAI key: usually already present (used by image/video too). If not, ask
   them to add it on the Config page Keys tab or fill `xai-api-key` in the vault.
3. Telephony account — only the ACTIVE provider's pieces are needed:
   - Twilio: open console.twilio.com, copy the Account SID and Auth Token into the
     vault slugs above (or the Plugins page secret fields), and buy one phone
     number. Ask for voice-enabled numbers in the countries they will call.
   - SignalWire: open dashboard.signalwire.com, copy the Space name, the Project
     ID and the API token (Voice scope) into the settings/vault slugs, and buy
     one voice-enabled phone number.
4. Public endpoint: on the web Config page → Endpoints tab, enable the endpoint for
   phone-agent and set `public_base` to that URL
   (`ob-plugin settings phone-agent public_base=…`).
5. Wire the number, in the ACTIVE provider's console, on the number, set
   “A call comes in” to `<public_base>/twilio/voice` (Twilio) or
   `<public_base>/signalwire/voice` (SignalWire), HTTP POST. Optional status
   callback: `/twilio/status` or `/signalwire/status`.
6. Signatures are mandatory: Twilio uses its Auth Token; SignalWire requires
   its Signing Key. Missing keys, wrong signatures, or the wrong provider fail
   with 403. Keep `public_base` exactly equal to the provider-facing URL,
   including its `/hooks/.../phone-agent` path; query strings are signed too.
   Old `*_verify=false` values no longer disable verification. Mocks must sign
   requests rather than turning verification off.
   The `/media` bridge requires a single-use ticket issued by a signed webhook,
   expiring after five minutes. The provider echoes it using nested Stream
   custom Parameters, so queryless media connections remain supported without
   an authentication bypass. Nothing reaches xAI until the start is verified.
   Dashboard APIs require the exact private page token, including in development.
   No configured page token means APIs fail closed; the dashboard proxy supplies
   it automatically in production.
7. Test: `ob-plugin-phone-agent-call --to "+1…" --mission "…"`, then check the
   Missions tab for the report. From a thread, just ask: “appelle … et …”.
