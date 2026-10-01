import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const input = path.resolve(process.env.BRIDGE_AUTH_EXPORT ?? "credentials.local-export.json");
const output = path.resolve(process.env.TRIGGER_ENV_EXPORT ?? "trigger.env.import");

const record = JSON.parse(await readFile(input, "utf8"));

const required = [
  "client_id",
  "ext_agent_host_id",
  "access_token",
  "refresh_token",
  "id_token",
  "saved_at",
];

for (const key of required) {
  if (!record[key]) throw new Error(`Credential export is missing ${key}`);
}

const scopes = Array.isArray(record.scopes)
  ? record.scopes.join(" ")
  : String(record.scope ?? "");

if (!scopes.split(/\s+/).includes("chatgpt.tokens.use.direct")) {
  throw new Error("Credential export does not include chatgpt.tokens.use.direct");
}

const expiresIn = Number(record.expires_in ?? 3600);
const savedAtMs = Date.parse(record.saved_at);
const expiresAt = Number.isFinite(savedAtMs)
  ? new Date(savedAtMs + expiresIn * 1000).toISOString()
  : "";

const quote = (value) => JSON.stringify(String(value ?? ""));

const lines = [
  `CHATGPT_SIWC_CLIENT_ID=${quote(record.client_id)}`,
  `CHATGPT_SIWC_EXT_AGENT_HOST_ID=${quote(record.ext_agent_host_id)}`,
  `CHATGPT_SIWC_ACCESS_TOKEN=${quote(record.access_token)}`,
  `CHATGPT_SIWC_REFRESH_TOKEN=${quote(record.refresh_token)}`,
  `CHATGPT_SIWC_ID_TOKEN=${quote(record.id_token)}`,
  `CHATGPT_SIWC_SCOPES=${quote(scopes)}`,
  `CHATGPT_SIWC_SAVED_AT=${quote(record.saved_at)}`,
  `CHATGPT_SIWC_EXPIRES_IN=${quote(expiresIn)}`,
  `CHATGPT_SIWC_EXPIRES_AT=${quote(expiresAt)}`,
  `CHATGPT_SIWC_EARLIEST_REFRESH_AT=${quote(record.earliest_refresh_at ?? "")}`,
  "",
];

await writeFile(output, lines.join("\n"), { mode: 0o600 });
try {
  await chmod(output, 0o600);
} catch {
  // Windows may not apply POSIX modes; keeping the file local is still required.
}

console.log(`Trigger environment import written to:\n${output}`);
console.log("Treat this file as a password. Do not commit it or paste it into chat.");
console.log("Paste its KEY=VALUE lines directly into Trigger.dev Production environment variables, then delete the local file when finished.");
