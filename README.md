# chatgpt-plan-trigger-bridge

A minimal, generic, open-source helper for connecting a durable orchestrator such as Trigger.dev to an eligible ChatGPT plan through OpenAI's official **Sign in with ChatGPT** flow.

## Status

**POC only. Not production-ready.**

The current primary role of this repository is to perform the first local OAuth authorization safely and export the resulting ChatGPT-plan credentials in a format that can be imported into Trigger.dev. The persistent bridge/VM implementation remains available only as a fallback if Trigger-only credential persistence or program eligibility proves unreliable.

## Current primary POC architecture

Stage A deliberately proves ChatGPT-plan inference with the fewest moving parts:

```text
local browser OAuth bootstrap
        |
        v
chatgpt-plan-trigger-bridge helper
        |
        | creates trigger.env.import locally
        v
Trigger.dev secret environment variables
        |
        | OAuth access token
        v
OpenAI /v1/models
        |
        v
OpenAI /v1/responses
store=false + stream=true
```

No `OPENAI_API_KEY` or `CODEX_API_KEY` should be configured for this qualification.

After direct inference passes, the next qualification is rotating OAuth refresh-token persistence from Trigger.dev itself, followed by endurance/cold-start testing. The VM bridge path is retained only as a fallback.

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

## Export credentials for Trigger.dev

After `npm run auth:local` completes successfully, run:

```bash
npm run auth:trigger-env
```

This creates a local file named:

```text
trigger.env.import
```

The file contains the OAuth registration/credential values required by the Trigger-only POC, including:

```text
CHATGPT_SIWC_CLIENT_ID
CHATGPT_SIWC_EXT_AGENT_HOST_ID
CHATGPT_SIWC_ACCESS_TOKEN
CHATGPT_SIWC_REFRESH_TOKEN
CHATGPT_SIWC_ID_TOKEN
CHATGPT_SIWC_SCOPES
CHATGPT_SIWC_SAVED_AT
CHATGPT_SIWC_EXPIRES_IN
CHATGPT_SIWC_EXPIRES_AT
CHATGPT_SIWC_EARLIEST_REFRESH_AT
```

`trigger.env.import`, `*.env.import`, credential JSON files and host JSON files are excluded by `.gitignore`.

Treat `trigger.env.import` as a password. Do not paste it into chat. Paste the `KEY=VALUE` lines directly into the Trigger.dev **Production** environment-variable UI, mark token-bearing values as secrets, then delete the local export when finished.

At minimum, these values are credential secrets and should be protected accordingly:

```text
CHATGPT_SIWC_ACCESS_TOKEN
CHATGPT_SIWC_REFRESH_TOKEN
CHATGPT_SIWC_ID_TOKEN
```

## Trigger-only qualification target

The private `Economy-in-Layers` orchestrator contains a qualification task that should:

1. read the ChatGPT-plan OAuth credentials from Trigger.dev Production environment variables;
2. confirm the `chatgpt.tokens.use.direct` scope;
3. call `GET /v1/models` to discover account-visible models dynamically;
4. select a visible text-capable model;
5. call `POST /v1/responses` with `store:false` and `stream:true`;
6. return the qualification phrase without using an OpenAI API key.

A successful Stage A proves direct Trigger.dev -> ChatGPT-plan inference. It does **not** yet prove durable refresh-token rotation.

## Next POC gates

1. Official Sign in with ChatGPT works with the eligible plan.
2. Direct Trigger.dev inference succeeds without `OPENAI_API_KEY` or `CODEX_API_KEY`.
3. OAuth refreshes are serialized so the same rotating refresh token cannot be used concurrently.
4. Replacement access/refresh credentials are persisted together in Trigger.dev shared secret storage.
5. Ten consecutive inference runs succeed.
6. At least one real token refresh/rotation succeeds.
7. A later cold run succeeds using the newly persisted credentials.
8. Revoked credentials produce a clean reauthorization state.
9. Plan-limit behavior is understood before production use.
10. Logs, metadata and task outputs never expose access/refresh/ID tokens.

## Fallback persistent bridge

If Trigger-only token persistence or deployment eligibility proves unreliable, this repository also contains a lightweight persistent bridge implementation.

Implemented fallback endpoints:

- `GET /health`
- `POST /v1/run`
- `POST /v1/reauth`
- `GET /v1/quota-status`

The bridge can keep a stable host identity, rotate credentials atomically, limit inference concurrency and normalize relevant auth/quota failures.

### Persistent VM setup

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

To run the fallback bridge, set a long random shared secret and start the service:

```bash
export BRIDGE_SHARED_SECRET='replace-with-a-long-random-secret'
npm start
```

Default listener: `0.0.0.0:8787`.

For remote connectivity, place it behind HTTPS and never expose port 8787 directly to the public internet without TLS and access controls. A hardened systemd example is included at:

```text
deploy/chatgpt-plan-trigger-bridge.service.example
```

## Current security / reliability behavior

- credential exports excluded by `.gitignore`;
- local OAuth uses PKCE, state and nonce;
- OAuth access/refresh tokens are never intentionally logged;
- fallback bridge credential updates use atomic file replacement;
- fallback bridge limits active inference concurrency;
- bounded request timeout;
- structured output validation is available in bridge mode;
- quota reset times are never guessed.

## Expected normalized bridge errors

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
- API keys, OAuth tokens, refresh tokens, ID tokens or credential profiles.

## Official references

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

## Security

Never commit credentials. Development and production secrets must be supplied by the runtime/secret manager and redacted from application logs.
