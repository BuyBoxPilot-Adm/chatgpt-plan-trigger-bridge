import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configDir = process.env.BRIDGE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "chatgpt-plan-trigger-bridge");
const hostFile = process.env.BRIDGE_HOST_FILE ?? path.join(configDir, "host.json");

await mkdir(path.dirname(hostFile), { recursive: true, mode: 0o700 });

try {
  const existing = JSON.parse(await readFile(hostFile, "utf8"));
  if (existing.ext_agent_host_id) {
    console.log(existing.ext_agent_host_id);
    process.exit(0);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const record = {
  ext_agent_host_id: `urn:uuid:${randomUUID()}`,
  created_at: new Date().toISOString(),
};

await writeFile(hostFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
console.log(record.ext_agent_host_id);
