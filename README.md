# chatgpt-plan-trigger-bridge

A minimal, generic, open-source bridge for connecting a durable orchestrator such as Trigger.dev to an eligible ChatGPT plan through OpenAI's official **Sign in with ChatGPT** flow.

## Status

**POC only. Not production-ready.**

The first goal is to prove authentication durability, token refresh, restart persistence, structured output, quota behavior, and safe observability before any downstream production workflow depends on this bridge.

## POC architecture

Phase A deliberately proves ChatGPT-plan inference with the fewest moving parts:

```text
Trigger.dev / any orchestrator
        |
        | HTTPS + bridge shared secret
        v
chatgpt-plan-trigger-bridge
        |
        | OAuth access token authorized for ChatGPT plan usage
        v
OpenAI public Responses endpoint
store=false + stream=true
        |
        v
structured JSON response
```

After Phase A passes, Phase B adds the officially supported **Codex app-server** mode using the same OAuth token lifecycle.

## Implemented endpoints

- `GET /health`
- `POST /v1/run`
- `POST /v1/reauth`
- `GET /v1/quota-status`

`POST /v1/run` accepts a prompt plus a JSON Schema, calls an eligible model through the ChatGPT-plan OAuth token, validates the returned structured JSON again with AJV, and normalizes relevant auth/quota errors.

The POC intentionally limits concurrency to one active inference.

## Local first-time authorization

Requirements: Node.js 22+ and npm.

```bash
git clone https://github.com/BuyBoxPilot-Adm/chatgpt-plan-trigger-bridge.git
cd chatgpt-plan-trigger-bridge
npm install
npm run auth:local
```

The helper:

1. creates/reuses a stable local `ext_agent_host_id`;
2. opens (or prints) the official `Continue with ChatGPT` authorization URL;
3. listens only on `127.0.0.1` for `/auth/callback`;
4. uses PKCE, state and nonce;
5. validates the OpenAI ID token against the published JWKS;
6. checks that `chatgpt.tokens.use.direct` was granted;
7. writes `credentials.local-export.json` with owner-only permissions.

**Never commit, paste into chat, or send that credential file through an insecure channel.**

## Persistent VM setup

On the VM, initialize its own stable host ID:

```bash
npm install
npm run host:init
```

Transfer the protected local credential export to the VM through a secure channel such as SCP, then import it while preserving the VM host identity:

```bash
npm run auth:import -- /secure/path/credentials.local-export.json
```

The imported credentials are written by default to:

```text
~/.config/chatgpt-plan-trigger-bridge/credentials.json
```

The bridge rotates access/refresh credentials atomically when refresh is required.

## Run the bridge

Set a long random secret in the runtime environment. Do not reuse an OpenAI credential.

```bash
export BRIDGE_SHARED_SECRET='replace-with-a-long-random-secret'
npm start
```

Default listener: `0.0.0.0:8787`.

For production/POC connectivity from Trigger.dev, place the bridge behind HTTPS (for example an existing reverse proxy on the VM) and never expose port 8787 directly to the public internet without TLS and access controls.

A hardened systemd example is included at:

```text
deploy/chatgpt-plan-trigger-bridge.service.example
```

## Trigger.dev variables

The private orchestrator should store, as secrets/environment variables:

```text
CHATGPT_PLAN_BRIDGE_URL=https://your-bridge-host.example
CHATGPT_PLAN_BRIDGE_SHARED_SECRET=<same long random bridge secret>
```

Do **not** configure `OPENAI_API_KEY` or `CODEX_API_KEY` for this POC.

## Current security / reliability behavior

- credentials excluded by `.gitignore`;
- bearer secret checked with timing-safe comparison;
- OAuth access/refresh tokens never intentionally logged;
- credential updates use atomic file replacement;
- one active inference at a time;
- bounded request timeout;
- structured output validated twice: OpenAI schema constraint + local AJV validation;
- explicit normalized errors for plan limit, auth failure, schema failure, timeout and unsupported capabilities;
- quota reset times are never guessed.

## Initial POC gates

1. Official Sign in with ChatGPT works with an eligible plan.
2. Stable host identity survives process and VM restarts.
3. Access-token refresh works without routine manual intervention.
4. Trigger/orchestrator -> bridge -> eligible Responses request -> valid structured JSON works.
5. Revoked credentials produce a clean `AUTH_REQUIRED` state.
6. Plan limits produce a clean `PLAN_LIMIT` state.
7. Logs never expose access/refresh tokens.
8. Ten consecutive end-to-end runs pass, including restart and refresh scenarios.
9. Representative workload is benchmarked against plan quota before production use.
10. Only after these gates pass is Codex app-server mode added and qualified.

## Expected normalized errors

- `AUTH_REQUIRED`
- `PLAN_INELIGIBLE`
- `PLAN_LIMIT`
- `UNSUPPORTED_CAPABILITY`
- `UPSTREAM_ERROR`
- `SCHEMA_INVALID`
- `TIMEOUT`
- `BUSY`

## CI

GitHub Actions runs Node 22 dependency installation and syntax checks on the public repository.

## Explicit non-goals

This repository must **not** contain:

- private prompts or editorial strategy;
- project-specific agent logic;
- research datasets;
- scripts or media assets;
- FFmpeg/Remotion pipelines;
- Google Drive or YouTube publishing logic;
- API keys, OAuth tokens, refresh tokens, or credential profiles.

## Official references

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

## Security

Never commit credentials. Development and production secrets must be supplied by the runtime/secret manager and redacted from application logs.
