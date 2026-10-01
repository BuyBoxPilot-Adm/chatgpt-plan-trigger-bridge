import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_ENDPOINT = `${ISSUER}/api/accounts/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const AGENT_NAME = process.env.BRIDGE_AGENT_NAME ?? "The Economy in Layers";

const configDir = process.env.BRIDGE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "chatgpt-plan-trigger-bridge");
const localHostFile = process.env.BRIDGE_LOCAL_HOST_FILE ?? path.join(configDir, "local-auth-host.json");
const exportFile = path.resolve(process.env.BRIDGE_AUTH_EXPORT ?? "credentials.local-export.json");

const base64url = (buffer) => Buffer.from(buffer).toString("base64url");
const randomToken = (bytes = 32) => base64url(randomBytes(bytes));

async function loadOrCreateLocalHostId() {
  await mkdir(path.dirname(localHostFile), { recursive: true, mode: 0o700 });
  try {
    const existing = JSON.parse(await readFile(localHostFile, "utf8"));
    if (existing.ext_agent_host_id) return existing.ext_agent_host_id;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const extAgentHostId = `urn:uuid:${randomUUID()}`;
  await writeFile(
    localHostFile,
    `${JSON.stringify({ ext_agent_host_id: extAgentHostId, created_at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return extAgentHostId;
}

function openBrowser(url) {
  let child;
  try {
    if (process.platform === "win32") {
      // Avoid `cmd /c start`: OAuth URLs contain `&`, which cmd.exe can interpret
      // as command separators and truncate the authorization request.
      child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
    } else if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore", shell: false });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore", shell: false });
    }
    child.on("error", () => {
      // The complete URL is printed below, so browser auto-open is only a convenience.
    });
    child.unref();
  } catch {
    // The complete URL is printed below, so browser auto-open is only a convenience.
  }
}

const extAgentHostId = await loadOrCreateLocalHostId();
const state = randomToken();
const nonce = randomToken();
const codeVerifier = randomToken(48);
const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());

const callbackResult = new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    try {
      const incoming = new URL(req.url, `http://${req.headers.host}`);
      if (incoming.pathname !== "/auth/callback") {
        res.writeHead(404).end("Not found");
        return;
      }

      const returnedState = incoming.searchParams.get("state");
      if (returnedState !== state) throw new Error("OAuth state mismatch");

      const oauthError = incoming.searchParams.get("error");
      if (oauthError) throw new Error(`OAuth error: ${oauthError}`);

      const code = incoming.searchParams.get("code");
      const issuedClientId = incoming.searchParams.get("client_id");
      if (!code) throw new Error("OAuth callback did not include an authorization code");
      if (!issuedClientId) throw new Error("Initial registration did not return an issued client_id");

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h2>ChatGPT authorization received.</h2><p>You can close this tab and return to the terminal.</p>");
      resolve({ code, issuedClientId, server });
    } catch (error) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Authorization failed: ${error.message}`);
      reject(error);
      server.close();
    }
  });

  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
    authorizeUrl.searchParams.set("client_id", "dynamic_agent_client");
    authorizeUrl.searchParams.set("agent_name_hint", AGENT_NAME);
    authorizeUrl.searchParams.set("ext_agent_host_id", extAgentHostId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", SCOPES);
    authorizeUrl.searchParams.set("resource", RESOURCE);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("nonce", nonce);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);

    console.log(`\nStarting ChatGPT authorization for: ${AGENT_NAME}`);
    console.log("\nOpen this URL to continue with ChatGPT if the browser does not open automatically:\n");
    console.log(authorizeUrl.toString());
    console.log("\nWaiting for the local callback...\n");
    openBrowser(authorizeUrl.toString());

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out after 10 minutes"));
    }, 10 * 60 * 1000).unref();

    server.redirectUri = redirectUri;
  });
});

const { code, issuedClientId, server } = await callbackResult;
const redirectUri = server.redirectUri;

try {
  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: issuedClientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      resource: RESOURCE,
    }),
  });

  const tokenBody = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !tokenBody?.access_token || !tokenBody?.id_token) {
    throw new Error(`Token exchange failed: HTTP ${tokenResponse.status} ${JSON.stringify(tokenBody)}`);
  }

  const { payload } = await jwtVerify(tokenBody.id_token, JWKS, {
    issuer: ISSUER,
    audience: issuedClientId,
  });

  if (payload.nonce !== nonce) throw new Error("ID token nonce mismatch");

  const scopes = String(tokenBody.scope ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes("chatgpt.tokens.use.direct")) {
    throw new Error("ChatGPT plan usage permission was not granted");
  }

  const record = {
    email: payload.email ?? null,
    issuer: ISSUER,
    subject: payload.sub,
    client_id: issuedClientId,
    ext_agent_host_id: extAgentHostId,
    id_token: tokenBody.id_token,
    access_token: tokenBody.access_token,
    refresh_token: tokenBody.refresh_token,
    token_type: tokenBody.token_type ?? "Bearer",
    expires_in: tokenBody.expires_in ?? 3600,
    earliest_refresh_at: tokenBody.earliest_refresh_at ?? null,
    scopes,
    saved_at: new Date().toISOString(),
  };

  await writeFile(exportFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(`Authorization succeeded. Protected credential export written to:\n${exportFile}`);
  console.log("Do not commit or paste this file into chat.");
} finally {
  server.close();
}
