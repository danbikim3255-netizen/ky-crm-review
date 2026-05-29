const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 18765;

// Microsoft Office — first-party, pre-consented in all M365 tenants
const MS_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";
const MS_SCOPE = "https://graph.microsoft.com/Files.Read.All offline_access";
const MS_TOKEN_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token";
const MS_AUTH_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";
const MS_DEVICE_CODE_URL = "https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode";
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const TOKEN_FILE = path.join(__dirname, ".proxy-token.json");

let tokenData = loadToken();
let pkceState = null;

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (data.refreshToken) return data;
    }
  } catch {}
  return null;
}

function saveToken(data) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), "utf8"); } catch {}
}

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const doReq = (reqUrl, redirects = 0) => {
      if (redirects > 10) { reject(new Error("Too many redirects")); return; }
      const parsed = new URL(reqUrl);
      const client = parsed.protocol === "https:" ? https : http;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: { ...(options.headers || {}) },
        timeout: options.timeout || 120000,
      };
      const req = client.request(opts, (res) => {
        if (!options.noRedirect && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, reqUrl).toString();
          doReq(loc, redirects + 1);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
      if (options.body) req.write(options.body);
      req.end();
    };
    doReq(url);
  });
}

function downloadToFile(url, filePath, userAgent) {
  return new Promise((resolve, reject) => {
    const doReq = (reqUrl, redirects = 0) => {
      if (redirects > 10) { reject(new Error("Too many redirects")); return; }
      const parsed = new URL(reqUrl);
      const client = parsed.protocol === "https:" ? https : http;
      const req = client.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80), path: parsed.pathname + parsed.search, method: "GET", headers: { "User-Agent": userAgent }, timeout: 600000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, reqUrl).toString();
          doReq(loc, redirects + 1); return;
        }
        const ws = fs.createWriteStream(filePath);
        let bytes = 0;
        res.on("data", (c) => { bytes += c.length; ws.write(c); });
        res.on("end", () => { ws.end(() => resolve((bytes / 1024 / 1024).toFixed(1))); });
        ws.on("error", reject);
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Download timeout")); });
      req.end();
    };
    doReq(url);
  });
}

const zlib = require("zlib");

function extractTextFromZipFile(filePath) {
  const TEXT_EXTS = /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|yaml|yml|properties|md)$/i;
  const IMG_EXTS = /\.(png|jpg|jpeg|bmp|gif|tiff|tif)$/i;
  const MAX_TEXT_FILES = 500;
  const MAX_FILE_SIZE = 200 * 1024 * 1024;
  const MAX_TOTAL_TEXT = 5000000;

  const buf = fs.readFileSync(filePath);
  const entries = [];
  // find End of Central Directory (scan from end)
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }

  let cdOff, cdCount;
  if (eocdOff >= 0 && buf.readUInt32LE(eocdOff + 16) === 0xFFFFFFFF) {
    // ZIP64
    let z64eocdLoc = -1;
    for (let i = eocdOff - 20; i >= Math.max(0, eocdOff - 40); i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) { z64eocdLoc = i; break; }
    }
    if (z64eocdLoc >= 0) {
      const z64off = Number(buf.readBigUInt64LE(z64eocdLoc + 8));
      if (z64off < buf.length && buf.readUInt32LE(z64off) === 0x06064b50) {
        cdCount = Number(buf.readBigUInt64LE(z64off + 32));
        cdOff = Number(buf.readBigUInt64LE(z64off + 48));
      }
    }
  }
  if (cdOff === undefined && eocdOff >= 0) {
    cdCount = buf.readUInt16LE(eocdOff + 10);
    cdOff = buf.readUInt32LE(eocdOff + 16);
  }
  if (cdOff === undefined || cdOff >= buf.length) return { files: [], images: [], allEntries: [], error: "ZIP 구조 해석 실패" };

  let off = cdOff;
  for (let i = 0; i < cdCount && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize32 = buf.readUInt32LE(off + 20);
    const uncompSize32 = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff32 = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    let compSize = compSize32, uncompSize = uncompSize32, localOff = localOff32;
    if (compSize32 === 0xFFFFFFFF || uncompSize32 === 0xFFFFFFFF || localOff32 === 0xFFFFFFFF) {
      let eOff = off + 46 + nameLen;
      const eEnd = eOff + extraLen;
      while (eOff + 4 <= eEnd) {
        const tag = buf.readUInt16LE(eOff);
        const sz = buf.readUInt16LE(eOff + 2);
        if (tag === 0x0001) {
          let p = eOff + 4;
          if (uncompSize32 === 0xFFFFFFFF && p + 8 <= eOff + 4 + sz) { uncompSize = Number(buf.readBigUInt64LE(p)); p += 8; }
          if (compSize32 === 0xFFFFFFFF && p + 8 <= eOff + 4 + sz) { compSize = Number(buf.readBigUInt64LE(p)); p += 8; }
          if (localOff32 === 0xFFFFFFFF && p + 8 <= eOff + 4 + sz) { localOff = Number(buf.readBigUInt64LE(p)); }
          break;
        }
        eOff += 4 + sz;
      }
    }

    entries.push({ name, method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  const allEntries = entries.map(e => ({ name: e.name, uncompSize: e.uncompSize }));
  const textEntries = entries.filter(e => TEXT_EXTS.test(e.name) && !e.name.endsWith("/") && e.uncompSize <= MAX_FILE_SIZE);
  const PRIORITY_RE = /error|err\.|\.err$|slow|migration|license|change|interface|\.db\.|stream/i;
  const LOW_PRIORITY_RE = /access\.log|nginx\.access/i;
  textEntries.sort((a, b) => {
    const ap = PRIORITY_RE.test(a.name) ? 0 : LOW_PRIORITY_RE.test(a.name) ? 2 : 1;
    const bp = PRIORITY_RE.test(b.name) ? 0 : LOW_PRIORITY_RE.test(b.name) ? 2 : 1;
    return ap - bp;
  });
  const imgEntries = entries.filter(e => IMG_EXTS.test(e.name) && !e.name.endsWith("/"));

  const files = [];
  let totalText = 0;
  for (const e of textEntries.slice(0, MAX_TEXT_FILES)) {
    if (totalText >= MAX_TOTAL_TEXT) break;
    try {
      const lhOff = e.localOff;
      if (lhOff + 30 > buf.length || buf.readUInt32LE(lhOff) !== 0x04034b50) continue;
      const lNameLen = buf.readUInt16LE(lhOff + 26);
      const lExtraLen = buf.readUInt16LE(lhOff + 28);
      const dataStart = lhOff + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + e.compSize;
      if (dataEnd > buf.length) continue;
      const raw = buf.slice(dataStart, dataEnd);
      let content;
      if (e.method === 0) content = raw;
      else if (e.method === 8) content = zlib.inflateRawSync(raw);
      else continue;
      const MAX_PER_FILE = 500000;
      let text = content.toString("utf8");
      if (text.length > MAX_PER_FILE) text = "... (앞부분 생략 — 마지막 500KB만 포함)\n" + text.substring(text.length - MAX_PER_FILE);
      if (text.length + totalText > MAX_TOTAL_TEXT) text = text.substring(0, MAX_TOTAL_TEXT - totalText) + "\n... (잘림)";
      files.push({ name: e.name, size: e.uncompSize, text });
      totalText += text.length;
    } catch {}
  }

  const images = [];
  for (const e of imgEntries.slice(0, 20)) {
    try {
      const lhOff = e.localOff;
      if (lhOff + 30 > buf.length || buf.readUInt32LE(lhOff) !== 0x04034b50) continue;
      const lNameLen = buf.readUInt16LE(lhOff + 26);
      const lExtraLen = buf.readUInt16LE(lhOff + 28);
      const dataStart = lhOff + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + e.compSize;
      if (dataEnd > buf.length) continue;
      const raw = buf.slice(dataStart, dataEnd);
      let content;
      if (e.method === 0) content = raw;
      else if (e.method === 8) content = zlib.inflateRawSync(raw);
      else continue;
      const ext = e.name.split(".").pop().toLowerCase();
      const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", bmp: "image/bmp", gif: "image/gif", tiff: "image/tiff", tif: "image/tiff" }[ext] || "image/png";
      images.push({ name: e.name, size: e.uncompSize, base64: content.toString("base64"), mediaType: mime });
    } catch {}
  }

  return { files, images, allEntries };
}

async function msPost(url, params) {
  const body = new URLSearchParams(params).toString();
  const resp = await makeRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    body,
    timeout: 15000,
  });
  return JSON.parse(resp.body.toString());
}

// ─── PKCE helpers ───
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function startAuthCodeFlow() {
  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString("hex");
  pkceState = { verifier, state };

  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: MS_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  const authUrl = `${MS_AUTH_URL}?${params.toString()}`;

  // Open browser
  const { exec } = require("child_process");
  exec(`start "" "${authUrl}"`);

  console.log("");
  console.log("  [AUTH] 브라우저에서 Microsoft 로그인 페이지가 열립니다...");
  console.log("  [AUTH] 로그인 후 자동으로 인증이 완료됩니다.");
  console.log("");

  return { authUrl, waiting: true };
}

async function exchangeCodeForToken(code) {
  if (!pkceState) throw new Error("No PKCE state");
  const result = await msPost(MS_TOKEN_URL, {
    client_id: MS_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkceState.verifier,
  });
  pkceState = null;
  if (result.error) throw new Error(result.error_description || result.error);
  tokenData = {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + (result.expires_in || 3600) * 1000,
  };
  saveToken(tokenData);
  console.log("  [AUTH] Microsoft 인증 완료!");
  return true;
}

// ─── Device Code flow (fallback) ───
let deviceCodeState = null;
let pollingTimer = null;

async function startDeviceCodeFlow() {
  const result = await msPost(MS_DEVICE_CODE_URL, { client_id: MS_CLIENT_ID, scope: MS_SCOPE });
  if (result.error) throw new Error(result.error_description || result.error);
  deviceCodeState = {
    deviceCode: result.device_code,
    userCode: result.user_code,
    verificationUri: result.verification_uri,
    interval: result.interval || 5,
    expiresAt: Date.now() + (result.expires_in || 900) * 1000,
  };
  console.log("");
  console.log(`  [AUTH] 코드: ${result.user_code}`);
  console.log(`  [AUTH] URL: ${result.verification_uri}`);
  console.log("");
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(pollDeviceCode, (deviceCodeState.interval + 1) * 1000);
  return deviceCodeState;
}

async function pollDeviceCode() {
  if (!deviceCodeState || Date.now() > deviceCodeState.expiresAt) {
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    deviceCodeState = null;
    return;
  }
  try {
    const result = await msPost(MS_TOKEN_URL, {
      client_id: MS_CLIENT_ID,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCodeState.deviceCode,
    });
    if (result.access_token) {
      tokenData = {
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + (result.expires_in || 3600) * 1000,
      };
      saveToken(tokenData);
      if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
      deviceCodeState = null;
      console.log("  [AUTH] Microsoft 인증 완료!");
    } else if (result.error !== "authorization_pending") {
      if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
      deviceCodeState = null;
      console.log(`  [AUTH] 인증 실패: ${result.error_description || result.error}`);
    }
  } catch (e) {
    console.log(`  [AUTH] 폴링 에러: ${e.message}`);
  }
}

async function refreshAccessToken() {
  if (!tokenData || !tokenData.refreshToken) return false;
  try {
    const result = await msPost(MS_TOKEN_URL, {
      client_id: MS_CLIENT_ID, grant_type: "refresh_token",
      refresh_token: tokenData.refreshToken, scope: MS_SCOPE,
    });
    if (result.access_token) {
      tokenData = {
        accessToken: result.access_token,
        refreshToken: result.refresh_token || tokenData.refreshToken,
        expiresAt: Date.now() + (result.expires_in || 3600) * 1000,
      };
      saveToken(tokenData);
      return true;
    }
  } catch {}
  tokenData = null;
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
  return false;
}

async function getValidToken() {
  if (!tokenData) return null;
  if (tokenData.expiresAt < Date.now() + 5 * 60 * 1000) {
    if (!(await refreshAccessToken())) return null;
  }
  return tokenData.accessToken;
}

async function graphGet(urlPath, token) {
  return graphGetWithHeaders(urlPath, token, {});
}

async function graphGetWithHeaders(urlPath, token, extraHeaders) {
  const url = urlPath.startsWith("http") ? urlPath : `https://graph.microsoft.com/v1.0${urlPath}`;
  const resp = await makeRequest(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extraHeaders },
    timeout: 30000,
  });
  if (resp.status !== 200) {
    const errText = resp.body.toString().substring(0, 300);
    throw new Error(`Graph API ${resp.status}: ${errText}`);
  }
  return JSON.parse(resp.body.toString());
}

async function getSharePointToken(hostname) {
  if (!tokenData || !tokenData.refreshToken) return null;
  try {
    const result = await msPost(MS_TOKEN_URL, {
      client_id: MS_CLIENT_ID, grant_type: "refresh_token",
      refresh_token: tokenData.refreshToken,
      scope: `https://${hostname}/.default offline_access`,
    });
    if (result.access_token) return result.access_token;
  } catch {}
  return null;
}

async function graphGetShareInfo(shareUrl, token) {
  const encoded = "u!" + Buffer.from(shareUrl).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const basePath = `/shares/${encoded}/driveItem`;
  // redeemSharingLink 헤더로 아직 redeem 안 된 공유 링크도 접근 가능
  const item = await graphGetWithHeaders(basePath, token, { "Prefer": "redeemSharingLink" });

  if (item.folder) {
    const files = await graphListChildren(basePath, token, "", 0);
    return { type: "folder", name: item.name, children: files };
  }

  return {
    type: "file",
    name: item.name,
    size: item.size,
    mimeType: item.file ? item.file.mimeType : "application/octet-stream",
    downloadUrl: item["@microsoft.graph.downloadUrl"] || null,
  };
}

async function graphListChildren(basePath, token, prefix, depth) {
  if (depth > 3) return [];
  const files = [];
  try {
    const data = await graphGet(`${basePath}/children?$top=200`, token);
    for (const child of (data.value || [])) {
      const name = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.folder) {
        if (child.parentReference && child.parentReference.driveId) {
          const subPath = `/drives/${child.parentReference.driveId}/items/${child.id}`;
          const subFiles = await graphListChildren(subPath, token, name, depth + 1);
          files.push(...subFiles);
        }
      } else {
        files.push({
          name,
          size: child.size,
          mimeType: child.file ? child.file.mimeType : "application/octet-stream",
          downloadUrl: child["@microsoft.graph.downloadUrl"] || null,
        });
      }
    }
  } catch (e) {
    console.log(`  [GRAPH] children 조회 실패: ${e.message}`);
  }
  return files;
}

function jsonResp(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = reqUrl.pathname;

  if (pathname === "/health") {
    return jsonResp(res, 200, { status: "ok", version: "3.0", authenticated: !!(tokenData && tokenData.accessToken) });
  }

  if (pathname === "/auth/status") {
    const authenticated = !!(tokenData && tokenData.accessToken);
    const pending = !!deviceCodeState || !!pkceState;
    const body = { authenticated, pending };
    if (deviceCodeState) {
      body.userCode = deviceCodeState.userCode;
      body.verificationUri = deviceCodeState.verificationUri;
    }
    if (pkceState) body.method = "browser";
    return jsonResp(res, 200, body);
  }

  // Primary auth: browser-based auth code flow with PKCE
  if (pathname === "/auth/start") {
    try {
      const result = startAuthCodeFlow();
      return jsonResp(res, 200, { method: "browser", waiting: true, message: "브라우저에서 Microsoft 로그인을 진행하세요" });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // Auth callback from Microsoft
  if (pathname === "/auth/callback") {
    const code = reqUrl.searchParams.get("code");
    const error = reqUrl.searchParams.get("error");
    const errorDesc = reqUrl.searchParams.get("error_description");

    if (error) {
      console.log(`  [AUTH] 인증 오류: ${error} — ${errorDesc}`);
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>인증 실패</title></head><body style="font-family:Malgun Gothic,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5"><div style="text-align:center;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1)"><h2 style="color:#d32f2f">인증 실패</h2><p style="color:#666">${errorDesc || error}</p><p style="color:#999;font-size:13px">이 창을 닫고 다시 시도하세요.</p></div></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (code) {
      try {
        await exchangeCodeForToken(code);
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>인증 완료</title></head><body style="font-family:Malgun Gothic,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5"><div style="text-align:center;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1)"><h2 style="color:#61A229">✓ 인증 완료</h2><p style="color:#666">SharePoint 파일 자동 분석이 가능합니다.</p><p style="color:#999;font-size:13px">이 창을 닫아도 됩니다.</p><script>setTimeout(()=>window.close(),3000)</script></div></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (e) {
        console.log(`  [AUTH] 토큰 교환 실패: ${e.message}`);
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>인증 실패</title></head><body style="font-family:Malgun Gothic,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5"><div style="text-align:center;background:white;padding:40px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.1)"><h2 style="color:#d32f2f">토큰 교환 실패</h2><p style="color:#666">${e.message}</p></div></body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      }
      return;
    }

    res.writeHead(400);
    res.end("Missing code parameter");
    return;
  }

  // Fallback auth: device code flow
  if (pathname === "/auth/device") {
    try {
      const state = await startDeviceCodeFlow();
      return jsonResp(res, 200, { method: "device_code", userCode: state.userCode, verificationUri: state.verificationUri });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  if (pathname === "/auth/check") {
    return jsonResp(res, 200, { authenticated: !!(tokenData && tokenData.accessToken), pending: !!deviceCodeState || !!pkceState });
  }

  if (pathname === "/auth/logout") {
    tokenData = null;
    deviceCodeState = null;
    pkceState = null;
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
    try { fs.unlinkSync(TOKEN_FILE); } catch {}
    console.log("  [AUTH] 로그아웃 완료");
    return jsonResp(res, 200, { ok: true });
  }

  if (pathname === "/sp-zip") {
    const shareUrl = reqUrl.searchParams.get("shareUrl");
    if (!shareUrl) return jsonResp(res, 400, { error: "Missing shareUrl" });
    const short = shareUrl.length > 60 ? shareUrl.substring(0, 60) + "..." : shareUrl;
    process.stdout.write(`  [SP-ZIP] ${short}`);
    const token = await getValidToken();
    if (!token) { console.log(" -> 인증 필요"); return jsonResp(res, 401, { error: "Not authenticated" }); }
    try {
      const info = await graphGetShareInfo(shareUrl, token);
      if (info.type === "folder") { console.log(" -> 폴더 (ZIP 아님)"); return jsonResp(res, 400, { error: "Not a file" }); }
      if (!info.downloadUrl) { console.log(" -> downloadUrl 없음"); return jsonResp(res, 502, { error: "No download URL" }); }
      const sizeMB = ((info.size || 0) / 1024 / 1024).toFixed(1);
      console.log(` -> ${info.name} (${sizeMB}MB) 다운로드 중...`);
      const tmpDir = path.join(require("os").tmpdir(), "sp-zip-" + Date.now());
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpFile = path.join(tmpDir, info.name || "download.zip");
      try {
        const dlResp = await makeRequest(info.downloadUrl, { timeout: 600000 });
        fs.writeFileSync(tmpFile, dlResp.body);
        console.log(`  [SP-ZIP] 다운로드 완료: ${Math.round(dlResp.body.length / 1024 / 1024)}MB`);
        const result = extractTextFromZipFile(tmpFile);
        const nestedZipEntries = result.allEntries.filter(e => /\.zip$/i.test(e.name) && e.uncompSize > 0);
        const nestedResults = [];
        for (const nz of nestedZipEntries.slice(0, 3)) {
          try {
            const zipBuf = fs.readFileSync(tmpFile);
            const entries = [];
            let eocdOff = -1;
            for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65558); i--) { if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; } }
            if (eocdOff < 0) continue;
            let cdOff2 = zipBuf.readUInt32LE(eocdOff + 16), cdCount2 = zipBuf.readUInt16LE(eocdOff + 10);
            if (cdOff2 === 0xFFFFFFFF) {
              for (let i = eocdOff - 20; i >= Math.max(0, eocdOff - 40); i--) {
                if (zipBuf.readUInt32LE(i) === 0x07064b50) { const z64off = Number(zipBuf.readBigUInt64LE(i + 8)); cdCount2 = Number(zipBuf.readBigUInt64LE(z64off + 32)); cdOff2 = Number(zipBuf.readBigUInt64LE(z64off + 48)); break; }
              }
            }
            let off2 = cdOff2;
            for (let i = 0; i < cdCount2 && off2 + 46 <= zipBuf.length; i++) {
              if (zipBuf.readUInt32LE(off2) !== 0x02014b50) break;
              const m = zipBuf.readUInt16LE(off2 + 10);
              let cs = zipBuf.readUInt32LE(off2 + 20), us = zipBuf.readUInt32LE(off2 + 24), lo = zipBuf.readUInt32LE(off2 + 42);
              const nl = zipBuf.readUInt16LE(off2 + 28), el = zipBuf.readUInt16LE(off2 + 30), cl = zipBuf.readUInt16LE(off2 + 32);
              const nm = zipBuf.toString("utf8", off2 + 46, off2 + 46 + nl);
              if (cs === 0xFFFFFFFF || us === 0xFFFFFFFF || lo === 0xFFFFFFFF) { let eO = off2+46+nl; const eE = eO+el; while(eO+4<=eE){const t=zipBuf.readUInt16LE(eO),s=zipBuf.readUInt16LE(eO+2);if(t===1){let p=eO+4;if(us===0xFFFFFFFF&&p+8<=eO+4+s){us=Number(zipBuf.readBigUInt64LE(p));p+=8;}if(cs===0xFFFFFFFF&&p+8<=eO+4+s){cs=Number(zipBuf.readBigUInt64LE(p));p+=8;}if(lo===0xFFFFFFFF&&p+8<=eO+4+s){lo=Number(zipBuf.readBigUInt64LE(p));}break;}eO+=4+s;} }
              entries.push({ name: nm, method: m, compSize: cs, uncompSize: us, localOff: lo });
              off2 += 46 + nl + el + cl;
            }
            const nzEntry = entries.find(e => e.name.endsWith(nz.name) || nz.name.endsWith(e.name));
            if (!nzEntry) continue;
            const lh = nzEntry.localOff;
            if (lh + 30 > zipBuf.length || zipBuf.readUInt32LE(lh) !== 0x04034b50) continue;
            const lnl = zipBuf.readUInt16LE(lh + 26), lel = zipBuf.readUInt16LE(lh + 28);
            const ds = lh + 30 + lnl + lel, de = ds + nzEntry.compSize;
            if (de > zipBuf.length) continue;
            const raw = zipBuf.slice(ds, de);
            let nestedBuf;
            if (nzEntry.method === 0) nestedBuf = raw;
            else if (nzEntry.method === 8) nestedBuf = zlib.inflateRawSync(raw);
            else continue;
            const nestedFile = path.join(tmpDir, nz.name.split("/").pop());
            fs.writeFileSync(nestedFile, nestedBuf);
            console.log(`  [SP-ZIP] 중첩 ZIP 추출: ${nz.name} (${Math.round(nestedBuf.length / 1024 / 1024)}MB)`);
            const nestedResult = extractTextFromZipFile(nestedFile);
            nestedResults.push({ name: nz.name, files: nestedResult.files, images: nestedResult.images, allEntries: nestedResult.allEntries });
            try { fs.unlinkSync(nestedFile); } catch {}
          } catch (e) { console.log(`  [SP-ZIP] 중첩 ZIP 처리 실패: ${nz.name} — ${e.message}`); }
        }
        try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch {}
        console.log(`  [SP-ZIP] 완료: ${result.files.length}개 텍스트, ${nestedResults.length}개 중첩ZIP`);
        return jsonResp(res, 200, { name: info.name, size: info.size, files: result.files, images: result.images, allEntries: result.allEntries, nestedZips: nestedResults });
      } catch (e) {
        try { fs.unlinkSync(tmpFile); fs.rmdirSync(tmpDir); } catch {}
        throw e;
      }
    } catch (e) { console.log(` -> 실패: ${e.message.substring(0, 100)}`); return jsonResp(res, 502, { error: e.message }); }
  }

  if (pathname === "/graph-info") {
    const shareUrl = reqUrl.searchParams.get("shareUrl");
    if (!shareUrl) return jsonResp(res, 400, { error: "Missing shareUrl" });

    const short = shareUrl.length > 60 ? shareUrl.substring(0, 60) + "..." : shareUrl;
    process.stdout.write(`  [GRAPH] ${short}`);

    const token = await getValidToken();
    if (!token) {
      console.log(" -> 인증 필요");
      return jsonResp(res, 401, { error: "Not authenticated", needAuth: true });
    }

    try {
      const info = await graphGetShareInfo(shareUrl, token);
      if (info.type === "folder") {
        console.log(` -> 폴더 (${info.children.length}개)`);
      } else {
        const sizeMB = ((info.size || 0) / 1024 / 1024).toFixed(1);
        console.log(` -> ${info.name} (${sizeMB}MB)`);
      }
      return jsonResp(res, 200, info);
    } catch (e) {
      console.log(` -> 실패: ${e.message.substring(0, 80)}`);
      return jsonResp(res, 502, { error: e.message });
    }
  }

  if (pathname === "/fetch") {
    const targetUrl = reqUrl.searchParams.get("url");
    if (!targetUrl) return jsonResp(res, 400, { error: "Missing url parameter" });

    const short = targetUrl.length > 70 ? targetUrl.substring(0, 70) + "..." : targetUrl;
    process.stdout.write(`  [FETCH] ${short}`);

    try {
      const reqHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "*/*",
      };
      const token = reqUrl.searchParams.get("token");
      if (token) reqHeaders["Authorization"] = `Bearer ${token}`;
      const accept = reqUrl.searchParams.get("accept");
      if (accept) reqHeaders["Accept"] = accept;

      // SharePoint URL이면 SharePoint REST API v2.0 shares 엔드포인트로 접근
      let targetUrlFinal = targetUrl;
      try {
        const parsedUrl = new URL(targetUrl);
        if (parsedUrl.hostname.includes("sharepoint.com") && !reqHeaders["Authorization"]) {
          const spToken = await getSharePointToken(parsedUrl.hostname);
          if (spToken) {
            // SharePoint REST API v2.0 shares endpoint로 변환
            const shareEncoded = "u!" + Buffer.from(targetUrl).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            const spApiUrl = `https://${parsedUrl.hostname}/_api/v2.0/shares/${shareEncoded}/driveItem`;
            console.log(`  [FETCH] SharePoint REST API 시도: ${parsedUrl.hostname}`);
            try {
              const spResp = await makeRequest(spApiUrl, {
                headers: { Authorization: `Bearer ${spToken}`, Accept: "application/json" },
                timeout: 30000,
              });
              if (spResp.status === 200) {
                const spData = JSON.parse(spResp.body.toString());
                const dlUrl = spData["@content.downloadUrl"] || spData["@microsoft.graph.downloadUrl"];
                if (dlUrl) {
                  console.log(` -> 다운로드 URL 획득: ${spData.name}`);
                  targetUrlFinal = dlUrl;
                  // downloadUrl은 인증 없이 직접 접근 가능
                  delete reqHeaders["Authorization"];
                }
              } else {
                console.log(` -> SP REST API ${spResp.status}`);
              }
            } catch (spErr) {
              console.log(` -> SP REST API 예외: ${spErr.message}`);
            }
          }
        }
      } catch {}

      const resp = await makeRequest(targetUrlFinal, { headers: reqHeaders, timeout: 120000 });
      const ct = resp.headers["content-type"];
      if (ct) res.setHeader("Content-Type", ct);
      res.setHeader("Content-Length", resp.body.length);
      res.writeHead(resp.status);
      res.end(resp.body);
      const sizeMB = (resp.body.length / 1024 / 1024).toFixed(1);
      console.log(` -> ${sizeMB}MB OK`);
    } catch (e) {
      console.log(` -> FAIL: ${e.message}`);
      jsonResp(res, 502, { error: e.message });
    }
    return;
  }

  if (pathname === "/ky-crm-review.js") {
    const jsPath = path.join(__dirname, "ky-crm-review.js");
    try {
      const js = fs.readFileSync(jsPath, "utf8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
      res.end(js);
    } catch (e) { res.writeHead(404); res.end("Not found"); }
    return;
  }

  if (pathname === "/api" && req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const targetUrl = reqUrl.searchParams.get("url");
      if (!targetUrl) return jsonResp(res, 400, { error: "Missing url parameter" });

      const short = targetUrl.length > 50 ? targetUrl.substring(0, 50) + "..." : targetUrl;
      const sizeMB = (body.length / 1024 / 1024).toFixed(2);
      process.stdout.write(`  [API] ${short} (${sizeMB}MB)`);

      try {
        const fwdHeaders = { "Content-Type": "application/json", "Content-Length": body.length };
        const apiKey = reqUrl.searchParams.get("key");
        if (apiKey) fwdHeaders["x-api-key"] = apiKey;
        const anthropicVer = reqUrl.searchParams.get("anthropic-version");
        if (anthropicVer) fwdHeaders["anthropic-version"] = anthropicVer;

        const resp = await makeRequest(targetUrl, {
          method: "POST",
          headers: fwdHeaders,
          body,
          timeout: 300000,
        });
        const ct = resp.headers["content-type"];
        if (ct) res.setHeader("Content-Type", ct);
        res.setHeader("Content-Length", resp.body.length);
        res.writeHead(resp.status);
        res.end(resp.body);
        console.log(` -> ${resp.status} OK`);
      } catch (e) {
        console.log(` -> FAIL: ${e.message}`);
        jsonResp(res, 502, { error: e.message });
      }
    });
    return;
  }

  if (pathname === "/dropbox") {
    const dbUrl = reqUrl.searchParams.get("url");
    if (!dbUrl) return jsonResp(res, 400, { error: "Missing url parameter" });
    const short = dbUrl.length > 50 ? dbUrl.substring(0, 50) + "..." : dbUrl;
    process.stdout.write(`  [DROPBOX] ${short}`);

    try {
      const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
      // dl=0 → dl=1 for direct download
      let directUrl = dbUrl.replace(/[?&]dl=0/, (m) => m[0] + "dl=1");
      if (!directUrl.includes("dl=1")) directUrl += (directUrl.includes("?") ? "&" : "?") + "dl=1";

      const tmpFile = path.join(require("os").tmpdir(), `db_${Date.now()}.bin`);
      const dlSizeMB = await downloadToFile(directUrl, tmpFile, UA);
      process.stdout.write(` ${dlSizeMB}MB`);

      const isZip = /\.zip/i.test(dbUrl);
      const isText = /\.(log|txt|csv|ini|cfg|conf|xml|json|dat|rsl|rpt|yaml|yml)$/i.test(dbUrl);
      const isPdf = /\.pdf$/i.test(dbUrl);

      try {
        if (isZip) {
          const extracted = extractTextFromZipFile(tmpFile);
          const result = JSON.stringify(extracted);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Content-Length", Buffer.byteLength(result));
          res.writeHead(200);
          res.end(result);
          console.log(` -> ZIP: ${extracted.files.length} texts, ${extracted.images.length} imgs OK`);
        } else if (isText) {
          const content = fs.readFileSync(tmpFile, "utf8");
          const result = JSON.stringify({ type: "text", content: content.substring(0, 2000000) });
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Content-Length", Buffer.byteLength(result));
          res.writeHead(200);
          res.end(result);
          console.log(` -> TEXT OK`);
        } else if (isPdf) {
          const pdfBuf = fs.readFileSync(tmpFile);
          const result = JSON.stringify({ type: "pdf", base64: pdfBuf.toString("base64"), size: pdfBuf.length });
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Content-Length", Buffer.byteLength(result));
          res.writeHead(200);
          res.end(result);
          console.log(` -> PDF OK`);
        } else {
          // unknown type — try ZIP first, fallback to binary info
          try {
            const extracted = extractTextFromZipFile(tmpFile);
            if (extracted.files.length > 0 || extracted.allEntries.length > 0) {
              const result = JSON.stringify(extracted);
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.setHeader("Content-Length", Buffer.byteLength(result));
              res.writeHead(200);
              res.end(result);
              console.log(` -> ZIP(detected): ${extracted.files.length} texts OK`);
            } else { throw new Error("not a zip"); }
          } catch {
            const stat = fs.statSync(tmpFile);
            return jsonResp(res, 200, { type: "unknown", size: stat.size, message: "자동 분석 미지원 형식" });
          }
        }
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    } catch (e) {
      console.log(` -> FAIL: ${e.message}`);
      jsonResp(res, 502, { error: e.message });
    }
    return;
  }

  if (pathname === "/wetransfer") {
    const wtUrl = reqUrl.searchParams.get("url");
    if (!wtUrl) return jsonResp(res, 400, { error: "Missing url parameter" });
    const short = wtUrl.length > 50 ? wtUrl.substring(0, 50) + "..." : wtUrl;
    process.stdout.write(`  [WT] ${short}`);

    try {
      const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

      // Step 1: resolve short URL (noRedirect to capture Location header)
      const r1 = await makeRequest(wtUrl, { headers: { "User-Agent": UA }, timeout: 15000, noRedirect: true });
      let finalUrl = wtUrl;
      if (r1.status >= 300 && r1.status < 400 && r1.headers.location) {
        finalUrl = r1.headers.location;
      }
      if (!finalUrl.includes("/downloads/")) {
        const r1b = await makeRequest(wtUrl, { headers: { "User-Agent": UA }, timeout: 15000 });
        const bodyStr = r1b.body.toString();
        const locMatch = bodyStr.match(/wetransfer\.com\/downloads\/([^"'\s<>]+)/);
        if (locMatch) finalUrl = `https://wetransfer.com/downloads/${locMatch[1]}`;
      }
      if (!finalUrl.includes("/downloads/")) { console.log(` -> FAIL: cannot resolve`); return jsonResp(res, 400, { error: "Cannot resolve WeTransfer URL" }); }

      const pathParts = new URL(finalUrl).pathname.replace("/downloads/", "").split("/").filter(Boolean);
      const transferId = pathParts[0];
      const securityHash = pathParts.length >= 3 ? pathParts[2] : pathParts[1];
      const recipientId = pathParts.length >= 3 ? pathParts[1] : undefined;

      // Step 2: get CSRF token + cookies
      const r2 = await makeRequest("https://wetransfer.com/", { headers: { "User-Agent": UA }, timeout: 15000 });
      const csrfMatch = r2.body.toString().match(/name="csrf-token" content="([^"]+)"/);
      const csrf = csrfMatch ? csrfMatch[1] : "";
      const cookies = (r2.headers["set-cookie"] || []);
      const cookieStr = (Array.isArray(cookies) ? cookies : [cookies]).map(c => c.split(";")[0]).join("; ");

      // Step 3: get direct download link
      const dlBody = JSON.stringify({ intent: "entire_transfer", security_hash: securityHash, ...(recipientId ? { recipient_id: recipientId } : {}) });
      const r3 = await makeRequest(`https://wetransfer.com/api/v4/transfers/${transferId}/download`, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/json", "x-requested-with": "XMLHttpRequest", "x-csrf-token": csrf, Cookie: cookieStr, "Content-Length": Buffer.byteLength(dlBody) },
        body: dlBody,
        timeout: 15000,
      });
      const dlData = JSON.parse(r3.body.toString());
      if (!dlData.direct_link) { console.log(` -> FAIL: no direct_link`); return jsonResp(res, 502, { error: "WeTransfer API returned no download link", detail: dlData }); }

      // Step 4: download to temp file, extract text/log files from ZIP
      const tmpFile = path.join(require("os").tmpdir(), `wt_${transferId}_${Date.now()}.bin`);
      const dlSizeMB = await downloadToFile(dlData.direct_link, tmpFile, UA);
      process.stdout.write(` ${dlSizeMB}MB`);

      try {
        const extracted = extractTextFromZipFile(tmpFile);
        const result = JSON.stringify(extracted);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Length", Buffer.byteLength(result));
        res.writeHead(200);
        res.end(result);
        console.log(` -> ${extracted.files.length} texts, ${extracted.images.length} imgs OK`);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    } catch (e) {
      console.log(` -> FAIL: ${e.message}`);
      jsonResp(res, 502, { error: e.message });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "localhost", () => {
  const authStatus = tokenData ? "인증됨" : "미인증";
  console.log("");
  console.log("  ============================================");
  console.log("  KY CRM Review CORS Proxy v3.0");
  console.log(`  http://localhost:${PORT}`);
  console.log("  ============================================");
  console.log("");
  console.log(`  Microsoft 인증: ${authStatus}`);
  if (tokenData) {
    console.log("  SharePoint/OneDrive 파일 자동 분석 가능");
  } else {
    console.log("  CRM에서 리뷰 시작 시 Microsoft 인증을 진행합니다.");
    console.log("  또는 직접 인증: http://localhost:18765/auth/start");
  }
  console.log("");
  console.log("  종료하려면 Ctrl+C 를 누르세요.");
  console.log("");

  if (tokenData) {
    getValidToken().then((t) => {
      if (t) console.log("  [AUTH] 토큰 유효성 확인 완료");
      else console.log("  [AUTH] 토큰 만료 — 리뷰 시 재인증 필요");
    }).catch(() => {});
  }
});
