# chatgpt-plan-trigger-bridge

A minimal, generic, open-source bridge for connecting a durable orchestration system such as Trigger.dev to an eligible ChatGPT plan through OpenAI's official **Sign in with ChatGPT** / Codex app-server flow.

## Status

**POC only. Not production-ready.**

The first goal is to prove authentication durability, token refresh, restart persistence, structured output, quota behavior, and safe observability before any downstream production workflow depends on this bridge.

## Intended architecture

```text
Trigger.dev / any orchestrator
        |
        | HTTPS + bridge auth
        v
chatgpt-plan-trigger-bridge
        |
        | official ChatGPT-plan OAuth lifecycle
        v
Codex app-server / eligible Responses requests
        |
        v
structured JSON response
```

## Scope

The bridge should only handle:

- a stable agent host identity;
- official ChatGPT-plan OAuth credentials and refresh lifecycle;
- Codex app-server lifecycle;
- authenticated `POST /v1/run` requests;
- JSON-schema validation;
- concurrency and rate limiting;
- idempotency;
- normalized auth/quota/upstream errors;
- health/auth state without exposing secrets.

## Explicit non-goals

This repository must **not** contain:

- private prompts or editorial strategy;
- project-specific agent logic;
- research datasets;
- scripts or media assets;
- FFmpeg/Remotion pipelines;
- Google Drive or YouTube publishing logic;
- API keys, OAuth tokens, refresh tokens, or credential profiles.

## Planned endpoints

- `GET /health`
- `POST /v1/run`
- `POST /v1/reauth`
- `GET /v1/quota-status`

## Initial POC gates

1. Official Sign in with ChatGPT works with an eligible plan.
2. Stable host identity survives process and VM restarts.
3. Access-token refresh works without routine manual intervention.
4. Trigger/orchestrator -> bridge -> Codex app-server -> valid structured JSON works.
5. Revoked credentials produce a clean `AUTH_REQUIRED` state.
6. Plan limits produce a clean `PLAN_LIMIT` state.
7. Logs never expose access/refresh tokens.
8. Ten consecutive end-to-end runs pass, including restart and refresh scenarios.
9. Representative workload is benchmarked against plan quota before production use.

## Expected normalized errors

- `AUTH_REQUIRED`
- `PLAN_LIMIT`
- `UPSTREAM_ERROR`
- `SCHEMA_INVALID`
- `TIMEOUT`

## Official references

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

## Security

Never commit credentials. Development and production secrets must be supplied by the runtime/secret manager and redacted from application logs.
