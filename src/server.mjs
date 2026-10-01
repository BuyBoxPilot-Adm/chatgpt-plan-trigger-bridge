import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";

const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const RESOURCE = "https://api.openai.com/v1";

const port = Number(process.env.PORT ?? 8787);
const sharedSecret = process.env.BRIDGE_SHARED_SECRET;
const configDir = process.env.BRIDGE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "chatgpt-plan-trigger-bridge");
const credentialsFile = process.env.BRIDGE_CREDENTIALS_FILE ?? path.join(configDir, "credentials.json");
const requestedModel = process.env.BRIDGE_MODEL ?? null;
const requestTimeoutMs = Number(process.env.BRIDGE_REQUEST_TIMEOUT_MS ?? 180000);

if (!sharedSecret) {
  console.error("BRIDGE_SHARED_SECRET is required");
  process.exit(1);
}

const ajv = new Ajv({ allErrors: true, strict: false });
let activeRun = false;
let cachedModel = null;

class BridgeError extends Error {
  constructor(code, message, httpStatus = 500, details = undefined) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function authorize(req) {
  const header = req.headers.authorization ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  return supplied && safeEqual(supplied, sharedSecret);
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBytes) throw new BridgeError("BAD_REQUEST", "Request body is too large", 413);
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new BridgeError("BAD_REQUEST", "Request body must be valid JSON", 400);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

async function loadCredentials() {
  try {
    return JSON.parse(await readFile(credentialsFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new BridgeError("AUTH_REQUIRED", "ChatGPT plan credentials are not configured", 401);
    throw new BridgeError("AUTH_REQUIRED", "ChatGPT plan credentials could not be read", 401);
  }
}

async function saveCredentials(record) {
  await mkdir(path.dirname(credentialsFile), { recursive: true, mode: 0o700 });
  const temp = `${credentialsFile}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, credentialsFile);
}

function expiresAt(record) {
  const saved = Date.parse(record.saved_at ?? "");
  const seconds = Number(record.expires_in ?? 3600);
  return Number.isFinite(saved) ? saved + seconds * 1000 : 0;
}

function earliestRefreshAt(record) {
  const value = record.earliest_refresh_at;
  if (!value) return 0;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function refreshCredentials(record) {
  if (!record.refresh_token || !record.client_id) {
    throw new BridgeError("AUTH_REQUIRED", "Refresh token or issued client_id is missing", 401);
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: record.client_id,
      refresh_token: record.refresh_token,
      resource: RESOURCE,
    }),
    signal: AbortSignal.timeout(30000),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error ?? body?.error?.code ?? "refresh_failed";
    if (["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(String(code))) {
      throw new BridgeError("AUTH_REQUIRED", "ChatGPT authorization must be renewed", 401);
    }
    throw new BridgeError("UPSTREAM_ERROR", `Token refresh failed with HTTP ${response.status}`, 502);
  }

  const next = {
    ...record,
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? record.refresh_token,
    id_token: body.id_token ?? record.id_token,
    token_type: body.token_type ?? record.token_type ?? "Bearer",
    expires_in: body.expires_in ?? 3600,
    earliest_refresh_at: body.earliest_refresh_at ?? null,
    scopes: String(body.scope ?? record.scopes?.join(" ") ?? "").split(/\s+/).filter(Boolean),
    saved_at: new Date().toISOString(),
  };

  await saveCredentials(next);
  cachedModel = null;
  return next;
}

async function ensureAccessToken() {
  let record = await loadCredentials();
  const now = Date.now();
  const expiry = expiresAt(record);
  const refreshFloor = earliestRefreshAt(record);
  const shouldRefresh = !record.access_token || expiry - now < 5 * 60 * 1000;

  if (shouldRefresh) {
    if (refreshFloor && now < refreshFloor && expiry - now > 60 * 1000) return record;
    record = await refreshCredentials(record);
  }

  if (!record.scopes?.includes?.("chatgpt.tokens.use.direct")) {
    throw new BridgeError("AUTH_REQUIRED", "Credential set does not include ChatGPT plan usage permission", 403);
  }

  return record;
}

async function resolveModel(accessToken) {
  if (requestedModel) return requestedModel;
  if (cachedModel) return cachedModel;

  const response = await fetch(MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw mapOpenAIError(response.status, body);

  const models = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [];
  const visible = models.filter((model) => model?.visibility === "list" || model?.id || model?.slug);
  const selected = visible[0]?.slug ?? visible[0]?.id;
  if (!selected) throw new BridgeError("UPSTREAM_ERROR", "No eligible ChatGPT-plan model was returned", 502);
  cachedModel = selected;
  return selected;
}

function mapOpenAIError(status, body) {
  const upstreamCode = body?.error?.code ?? body?.code ?? body?.error ?? "unknown_error";
  const code = String(upstreamCode);

  if (code === "subscription_sharing_usage_limit_exceeded") {
    return new BridgeError("PLAN_LIMIT", "ChatGPT plan usage limit reached for this app/account", 429, { upstream_code: code });
  }
  if (code === "subscription_sharing_user_not_eligible") {
    return new BridgeError("PLAN_INELIGIBLE", "Selected ChatGPT account/workspace is not eligible for plan usage", 403, { upstream_code: code });
  }
  if (["subscription_sharing_invalid_user", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"].includes(code) || status === 401) {
    return new BridgeError("AUTH_REQUIRED", "ChatGPT authorization is invalid or no longer usable", 401, { upstream_code: code });
  }
  if (code === "subscription_sharing_unsupported_capability") {
    return new BridgeError("UNSUPPORTED_CAPABILITY", "Request used a capability not supported by ChatGPT plan usage", 400, { upstream_code: code, param: body?.error?.param });
  }
  return new BridgeError("UPSTREAM_ERROR", `OpenAI request failed with HTTP ${status}`, status >= 500 ? 502 : status, { upstream_code: code });
}

async function callStructuredResponse({ accessToken, model, prompt, outputSchema, taskType }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: `You are executing task type ${taskType || "generic"}. Follow the user request carefully. Do not invent unsupported facts. Return only data matching the requested JSON schema.`,
        input: [{ role: "user", content: prompt }],
        text: {
          format: {
            type: "json_schema",
            name: "bridge_output",
            strict: true,
            schema: outputSchema,
          },
        },
        store: false,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw mapOpenAIError(response.status, body);
    }

    let buffer = "";
    let outputText = "";
    let completed = false;

    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString("utf8");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const packet = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = packet.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const data = dataLine.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === "response.output_text.delta") outputText += event.delta ?? "";
        if (event.type === "response.failed") throw mapOpenAIError(400, event.response ?? event);
        if (event.type === "error") throw mapOpenAIError(400, event);
        if (event.type === "response.completed") completed = true;
      }
    }

    if (!completed) throw new BridgeError("UPSTREAM_ERROR", "OpenAI stream ended without response.completed", 502);

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      throw new BridgeError("SCHEMA_INVALID", "Model output was not valid JSON", 502);
    }

    const validate = ajv.compile(outputSchema);
    if (!validate(parsed)) {
      throw new BridgeError("SCHEMA_INVALID", "Model output did not match the requested schema", 502, { validation_errors: validate.errors });
    }

    return { model, output: parsed };
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new BridgeError("TIMEOUT", "Upstream inference timed out", 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorize(req)) {
      sendJson(res, 401, { ok: false, code: "UNAUTHORIZED" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      let auth = "ready";
      try {
        const record = await loadCredentials();
        if (!record.access_token || !record.refresh_token) auth = "incomplete";
      } catch {
        auth = "missing";
      }
      sendJson(res, 200, { ok: true, service: "chatgpt-plan-trigger-bridge", auth, busy: activeRun });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/quota-status") {
      sendJson(res, 200, {
        ok: true,
        note: "The bridge does not infer quota reset times. Use ChatGPT Settings → Usage for plan/app usage details.",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/run") {
      if (activeRun) throw new BridgeError("BUSY", "Bridge POC concurrency is limited to one active run", 429);
      const body = await readJsonBody(req);
      if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new BridgeError("BAD_REQUEST", "prompt is required", 400);
      if (!body.output_schema || typeof body.output_schema !== "object") throw new BridgeError("BAD_REQUEST", "output_schema is required", 400);

      activeRun = true;
      try {
        const credentials = await ensureAccessToken();
        const model = await resolveModel(credentials.access_token);
        const result = await callStructuredResponse({
          accessToken: credentials.access_token,
          model,
          prompt: body.prompt,
          outputSchema: body.output_schema,
          taskType: body.task_type,
        });
        sendJson(res, 200, {
          ok: true,
          request_id: body.request_id ?? null,
          task_type: body.task_type ?? "generic",
          ...result,
        });
      } finally {
        activeRun = false;
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/reauth") {
      throw new BridgeError("AUTH_REQUIRED", "Run the local OAuth helper and securely replace the bridge credential file", 401);
    }

    sendJson(res, 404, { ok: false, code: "NOT_FOUND" });
  } catch (error) {
    const normalized = error instanceof BridgeError
      ? error
      : new BridgeError("INTERNAL_ERROR", "Unexpected bridge error", 500);
    console.error(`[bridge] ${normalized.code}: ${normalized.message}`);
    sendJson(res, normalized.httpStatus, {
      ok: false,
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`chatgpt-plan-trigger-bridge listening on :${port}`);
});
