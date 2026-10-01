import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sourceArg = process.argv[2];
if (!sourceArg) {
  console.error("Usage: npm run auth:import -- /path/to/credentials.local-export.json");
  process.exit(1);
}

const configDir = process.env.BRIDGE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "chatgpt-plan-trigger-bridge");
const hostFile = process.env.BRIDGE_HOST_FILE ?? path.join(configDir, "host.json");
const credentialsFile = process.env.BRIDGE_CREDENTIALS_FILE ?? path.join(configDir, "credentials.json");

await mkdir(configDir, { recursive: true, mode: 0o700 });

let host;
try {
  host = JSON.parse(await readFile(hostFile, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  host = {
    ext_agent_host_id: `urn:uuid:${randomUUID()}`,
    created_at: new Date().toISOString(),
  };
  await writeFile(hostFile, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
}

if (!host.ext_agent_host_id) throw new Error("VM host file is missing ext_agent_host_id");

const imported = JSON.parse(await readFile(path.resolve(sourceArg), "utf8"));
for (const key of ["client_id", "access_token", "refresh_token", "id_token", "subject"]) {
  if (!imported[key]) throw new Error(`Credential export is missing ${key}`);
}
if (!Array.isArray(imported.scopes) || !imported.scopes.includes("chatgpt.tokens.use.direct")) {
  throw new Error("Credential export does not include ChatGPT plan usage permission");
}

const record = {
  ...imported,
  ext_agent_host_id: host.ext_agent_host_id,
  imported_at: new Date().toISOString(),
};

const temp = `${credentialsFile}.${process.pid}.tmp`;
await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
await rename(temp, credentialsFile);

console.log(`Credentials imported securely into ${credentialsFile}`);
console.log(`VM host id preserved as ${host.ext_agent_host_id}`);
console.log("No token values were printed.");
