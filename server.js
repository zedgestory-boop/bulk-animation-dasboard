'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PRIMARY_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const MAX_SCAN_SIZE = 200 * 1024 * 1024; // 200 MiB, scan only
const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20 MiB per Roblox upload
const MAX_BATCH_FILES = 1000;
const ROBLOX_REQUEST_TIMEOUT_MS = 30000;
const ROBLOX_API = 'https://apis.roblox.com/assets/v1';

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Basic Auth protects dashboard/API. Keep DASHBOARD_PASSWORD in Railway Variables.
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/api/config-status') return next();

  const configuredPassword = String(process.env.DASHBOARD_PASSWORD || '').trim();
  // Fail closed in production: never expose dashboard or upload endpoints without a password.
  if (!configuredPassword) {
    return res.status(503).send('Dashboard belum dikunci. Tambahkan DASHBOARD_PASSWORD di Railway Variables, lalu redeploy.');
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Bulk Animation Dashboard", charset="UTF-8"');
    return res.status(401).send('Login diperlukan. Masukkan username admin dan password dashboard.');
  }

  let decoded = '';
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch (_) {}
  const colon = decoded.indexOf(':');
  const username = colon >= 0 ? decoded.slice(0, colon) : '';
  const password = colon >= 0 ? decoded.slice(colon + 1) : '';
  if (!safeEqual(username, 'admin') || !safeEqual(password, configuredPassword)) {
    res.set('WWW-Authenticate', 'Basic realm="Bulk Animation Dashboard", charset="UTF-8"');
    return res.status(401).send('Username atau password salah.');
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.get('/api/config-status', (_req, res) => {
  const hasApiKey = Boolean(process.env.ROBLOX_API_KEY && process.env.ROBLOX_API_KEY.trim());
  const userId = String(process.env.ROBLOX_USER_ID || '').trim();
  const groupId = String(process.env.ROBLOX_GROUP_ID || '').trim();
  const hasPassword = Boolean(process.env.DASHBOARD_PASSWORD && process.env.DASHBOARD_PASSWORD.trim());
  const isRailway = Boolean(process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

  res.json({
    status: 'ok',
    railwayConnected: isRailway || hasApiKey || userId || groupId,
    isRailway,
    hasApiKey,
    apiKeyMasked: hasApiKey ? 'configured' : null,
    creatorType: groupId ? 'group' : (userId ? 'user' : 'none'),
    creatorId: groupId || userId || '',
    hasPassword,
    concurrencyDefault: 10,
    maxBatchFiles: MAX_BATCH_FILES
  });
});

app.get('/api/test-connection', async (_req, res) => {
  const apiKey = String(process.env.ROBLOX_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(400).json({
      connected: false,
      authenticated: false,
      error: 'ROBLOX_API_KEY belum dikonfigurasi di Railway Variables.'
    });
  }

  let creator;
  try {
    creator = getCreator();
  } catch (e) {
    return res.status(400).json({ connected: false, authenticated: false, error: e.message });
  }

  try {
    // Roblox has no generic "validate API key" endpoint. An intentionally invalid
    // operation ID tests the authenticated endpoint without creating or changing assets.
    const response = await fetch(`${ROBLOX_API}/operations/__connection_test_invalid_operation__`, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(10000)
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}

    if (response.status === 401) {
      return res.status(401).json({
        connected: false,
        authenticated: false,
        apiStatus: response.status,
        error: 'Roblox menolak API key (401). Periksa key, status aktif, dan scope.'
      });
    }
    if (response.status === 403) {
      return res.status(403).json({
        connected: true,
        authenticated: false,
        apiStatus: response.status,
        error: 'Roblox dapat dijangkau, tetapi key tidak memiliki izin Read/asset:read yang diperlukan untuk memeriksa operasi.'
      });
    }

    return res.json({
      connected: true,
      authenticated: true,
      apiStatus: response.status,
      message: 'Endpoint Roblox merespons dan permintaan tidak ditolak dengan 401/403. Uji upload nyata tetap diperlukan untuk memastikan izin grup dan tipe aset.',
      creator: creator.creator,
      diagnostic: payload.message || payload.error || 'Koneksi teruji tanpa membuat aset.'
    });
  } catch (err) {
    return res.status(502).json({
      connected: false,
      authenticated: false,
      error: `Gagal menghubungi Roblox Open Cloud: ${err.message}`
    });
  }
});
app.use(express.static(path.join(__dirname, 'public')));

const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCAN_SIZE, files: 1 }
});
const animationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 }
});

function multerError(err, res) {
  if (!err) return false;
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'Ukuran file melewati batas. Batas scan 200 MiB; batas upload Roblox 20 MiB per file.' });
  } else {
    res.status(400).json({ error: err.message || 'File tidak dapat diproses.' });
  }
  return true;
}

app.post('/api/scan-rbxm', (req, res) => {
  scanUpload.single('file')(req, res, (err) => {
    if (multerError(err, res)) return;
    if (!req.file) return res.status(400).json({ error: 'Pilih file .rbxm atau .rbxmx terlebih dahulu.' });
    const filename = req.file.originalname || 'upload.rbxm';
    if (!/\.(rbxm|rbxmx)$/i.test(filename)) {
      return res.status(400).json({ error: 'Format file harus .rbxm atau .rbxmx.' });
    }
    const content = req.file.buffer.toString('latin1');
    const matches = content.match(/rbxassetid:\/\/\d{5,20}/gi) || [];
    const ids = [...new Set(matches.map(v => v.match(/\d{5,20}/)[0]))];
    return res.json({ filename, ids, count: ids.length, note: ids.length ? 'Pemindaian selesai.' : 'Tidak ditemukan ID dengan pola rbxassetid:// di file ini.' });
  });
});

function getCreator(overrideType, overrideId) {
  const oType = String(overrideType || '').trim().toLowerCase();
  const oId = String(overrideId || '').trim();

  // An explicit target must be complete and valid. Never silently fall back
  // to the Railway default when a user selected personal/group ownership.
  if (oType === 'group' || oType === 'user') {
    if (!/^\d{1,20}$/.test(oId)) {
      throw new Error(oType === 'user'
        ? 'Masukkan User ID numerik akun pribadi yang valid.'
        : 'Masukkan Group ID numerik grup Roblox yang valid.');
    }
    return oType === 'group'
      ? { creator: { groupId: oId } }
      : { creator: { userId: oId } };
  }
  if (oType && oType !== 'env') {
    throw new Error('Tipe creator tidak valid. Pilih akun pribadi, grup, atau target default Railway.');
  }

  const groupId = String(process.env.ROBLOX_GROUP_ID || '').trim();
  const userId = String(process.env.ROBLOX_USER_ID || '').trim();
  if (groupId && /^\d{1,20}$/.test(groupId)) return { creator: { groupId } };
  if (userId && /^\d{1,20}$/.test(userId)) return { creator: { userId } };
  if (groupId || userId) {
    throw new Error('ROBLOX_GROUP_ID atau ROBLOX_USER_ID harus berisi ID numerik yang valid.');
  }
  throw new Error('Isi ROBLOX_USER_ID atau ROBLOX_GROUP_ID di Railway Variables, atau pilih target creator di panel.');
}

function extractModerationState(payload) {
  // Roblox may return the moderation state in the operation's response Asset.
  const candidates = [
    payload?.response?.moderationResult?.moderationState,
    payload?.moderationResult?.moderationState,
    payload?.response?.moderationState,
    payload?.moderationState
  ];
  const raw = candidates.find(v => typeof v === 'string' && v.trim());
  if (!raw) return 'Unknown';
  const value = raw.trim();
  const normalized = value.toUpperCase();
  if (normalized === 'MODERATION_STATE_APPROVED' || normalized === 'APPROVED') return 'Approved';
  if (normalized === 'MODERATION_STATE_REJECTED' || normalized === 'REJECTED') return 'Rejected';
  if (
    normalized === 'MODERATION_STATE_PENDING' ||
    normalized === 'PENDING' ||
    normalized === 'MODERATION_STATE_REVIEW_PENDING' ||
    normalized === 'REVIEWING' ||
    normalized === 'MODERATION_STATE_REVIEWING'
  ) return 'Pending';
  return value;
}

async function resolveModerationState(operation, assetId, apiKey) {
  const fromOperation = extractModerationState(operation);
  if (fromOperation !== 'Unknown' || !assetId) return fromOperation;

  // Some responses omit moderationResult on the operation. Try the asset version endpoint.
  // This is a best-effort read; if asset:read permission is missing, keep the honest Unknown state.
  const revisionId = String(operation?.response?.revisionId || '1');
  const candidates = [revisionId, '1'].filter((value, index, all) => all.indexOf(value) === index);
  for (const version of candidates) {
    try {
      const response = await fetch(
        `${ROBLOX_API}/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(version)}`,
        {
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(ROBLOX_REQUEST_TIMEOUT_MS)
        }
      );
      if (!response.ok) continue;
      const data = await response.json();
      const state = extractModerationState(data);
      if (state !== 'Unknown') return state;
    } catch (_) {
      // Keep trying a fallback version, then return Unknown without failing the successful upload.
    }
  }
  return 'Unknown';
}

async function readRobloxResponse(response) {
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
  if (!response.ok) {
    const detail = data?.message || data?.error || data?.raw || `HTTP ${response.status}`;
    const error = new Error(String(detail));
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function getOperation(operationId) {
  const apiKey = process.env.ROBLOX_API_KEY;
  const response = await fetch(`${ROBLOX_API}/operations/${encodeURIComponent(operationId)}`, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(ROBLOX_REQUEST_TIMEOUT_MS)
  });
  return readRobloxResponse(response);
}

async function uploadAnimationBuffer(buffer, filename, displayName, description, creatorContext, apiKey) {
  const form = new FormData();
  form.append('request', JSON.stringify({
    assetType: 'Animation',
    displayName: displayName || 'Animation',
    description: description || 'Uploaded using Bulk Animation Dashboard',
    creationContext: creatorContext
  }));
  const ext = path.extname(filename).toLowerCase();
  if (!['.rbxm', '.rbxmx'].includes(ext)) {
    throw new Error('Upload aset Animation melalui Open Cloud hanya menerima file .rbxm atau .rbxmx. File .fbx bukan format upload Animation di endpoint ini.');
  }
  form.append('fileContent', new Blob([buffer], { type: 'model/x-rbxm' }), filename);

  const response = await fetch(`${ROBLOX_API}/assets`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: form,
    signal: AbortSignal.timeout(ROBLOX_REQUEST_TIMEOUT_MS)
  });
  const data = await readRobloxResponse(response);
  const operationPath = data.path || data.operationPath || '';
  let operationId = data.operationId || data.id || '';
  if (!operationId && operationPath) operationId = operationPath.split('/').filter(Boolean).pop();
  if (!operationId && data.assetId) {
    return { status: 'success', assetId: String(data.assetId), operationId: '', moderationState: extractModerationState(data), response: data };
  }
  if (!operationId) {
    const error = new Error('Roblox tidak mengembalikan operation ID. Periksa respons Roblox sebelum mengulang agar tidak membuat aset duplikat.');
    error.response = data;
    error.uncertain = true;
    throw error;
  }

  // Poll for up to 25 seconds
  let operation = null;
  for (let i = 0; i < 25; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      operation = await getOperation(operationId);
    } catch (pollError) {
      if (pollError.status === 401 || pollError.status === 403) throw pollError;
      continue;
    }
    const done = operation.done === true || operation.status === 'Succeeded' || operation.status === 'Failed';
    if (done) break;
  }

  const isDone = operation && (operation.done === true || operation.status === 'Succeeded' || operation.status === 'Failed');
  if (!isDone) {
    return { status: 'processing', operationId, message: 'Roblox masih memproses aset. Jangan unggah ulang file ini dulu.' };
  }
  if (operation.error || operation.status === 'Failed') {
    const err = new Error(operation.error?.message || operation.error || 'Roblox gagal memproses aset.');
    err.status = 422;
    err.operationId = operationId;
    err.response = operation;
    throw err;
  }
  const assetId = operation.response?.assetId || operation.assetId || data.assetId || null;
  return {
    status: 'success',
    assetId: assetId ? String(assetId) : null,
    operationId,
    moderationState: await resolveModerationState(operation, assetId ? String(assetId) : null, apiKey),
    response: operation
  };
}

app.post('/api/upload-animation', (req, res) => {
  animationUpload.single('file')(req, res, async (err) => {
    if (multerError(err, res)) return;
    if (!req.file) return res.status(400).json({ error: 'Pilih satu file terlebih dahulu.' });

    const apiKey = process.env.ROBLOX_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ROBLOX_API_KEY belum diatur di Railway Variables (.env).' });

    const filename = req.file.originalname || 'animation.fbx';
    const displayName = String(req.body.displayName || path.parse(filename).name).trim().slice(0, 50);
    const description = String(req.body.description || 'Uploaded using Bulk Animation Dashboard').trim().slice(0, 1000);
    const ext = path.extname(filename).toLowerCase();
    if (!['.rbxm', '.rbxmx'].includes(ext)) {
      return res.status(400).json({
        error: 'Untuk membuat aset Animation lewat Roblox Open Cloud, pilih file .rbxm atau .rbxmx. File .fbx adalah format model 3D, bukan upload Animation.'
      });
    }

    let creatorContext;
    try {
      creatorContext = getCreator(req.body.creatorType, req.body.creatorId);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    try {
      const result = await uploadAnimationBuffer(req.file.buffer, filename, displayName, description, creatorContext, apiKey);
      const httpStatus = result.status === 'processing' ? 202 : 200;
      return res.status(httpStatus).json(result);
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      return res.status(status).json({ error: e.message || 'Upload ke Roblox gagal.', details: e.details || null });
    }
  });
});

// Deliberately disable arbitrary-ID re-upload. Use source files that you own or are licensed to upload.
app.post('/api/spoof-by-id', (_req, res) => {
  return res.status(410).json({
    error: 'Upload ulang langsung dari Asset ID dinonaktifkan. Untuk menghindari pemindahan aset tanpa izin, unggah file .rbxm/.rbxmx milik sendiri atau yang berlisensi.'
  });
});

app.get('/api/operation/:operationId', async (req, res) => {
  const apiKey = process.env.ROBLOX_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ROBLOX_API_KEY belum diatur di Railway Variables.' });
  try {
    const operation = await getOperation(req.params.operationId);
    const done = operation.done === true || operation.status === 'Succeeded' || operation.status === 'Failed';
    if (!done) return res.status(202).json({ status: 'processing', operationId: req.params.operationId });
    if (operation.error || operation.status === 'Failed') {
      return res.status(422).json({ status: 'failed', operationId: req.params.operationId, error: operation.error?.message || operation.error || 'Roblox gagal memproses aset.' });
    }
    const assetId = operation.response?.assetId || operation.assetId || null;
    const moderationState = await resolveModerationState(operation, assetId ? String(assetId) : null, apiKey);
    return res.json({ status: 'success', operationId: req.params.operationId, assetId, moderationState, response: operation });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message || 'Gagal memeriksa status operasi Roblox.' });
  }
});

// Endpoint to replace / spoof animation IDs inside RBXM / RBXMX files
app.post('/api/replace-rbxm-ids', (req, res) => {
  scanUpload.single('file')(req, res, (err) => {
    if (multerError(err, res)) return;
    if (!req.file) return res.status(400).json({ error: 'Pilih file .rbxm atau .rbxmx.' });

    let idMap = {};
    try {
      idMap = JSON.parse(req.body.idMap || '{}');
    } catch (_) {
      return res.status(400).json({ error: 'Format idMap tidak valid.' });
    }
    if (!idMap || typeof idMap !== 'object' || Array.isArray(idMap)) {
      return res.status(400).json({ error: 'idMap harus berupa object JSON.' });
    }
    if (Object.keys(idMap).length > 1000) {
      return res.status(400).json({ error: 'Maksimal 1.000 pasangan ID per proses.' });
    }

    const filename = path.basename(req.file.originalname || 'animation.rbxm').replace(/["\\]/g, '_');
    const ext = path.extname(filename).toLowerCase();
    const isTextConfig = ['.lua', '.txt'].includes(ext);
    if (!['.rbxm', '.rbxmx', '.lua', '.txt'].includes(ext)) {
      return res.status(400).json({ error: 'Format yang didukung: .rbxm, .rbxmx, .lua, atau .txt.' });
    }

    // RBXM/RBXMX are treated as binary and only explicit rbxassetid:// references
    // are replaced. Lua/TXT configs are UTF-8 text and may contain bare numeric IDs.
    let content = req.file.buffer.toString(isTextConfig ? 'utf8' : 'latin1');
    let replacedCount = 0;

    for (const [oldId, newId] of Object.entries(idMap)) {
      const cleanOld = String(oldId).replace(/^rbxassetid:\/\//i, '').trim();
      const cleanNew = String(newId).replace(/^rbxassetid:\/\//i, '').trim();
      if (!/^\d{5,20}$/.test(cleanOld) || !/^\d{5,20}$/.test(cleanNew)) {
        return res.status(400).json({ error: 'Setiap ID lama dan baru harus berupa Asset ID Roblox numerik 5–20 digit.' });
      }

      const uriPattern = new RegExp('rbxassetid://' + cleanOld + '(?!\\d)', 'g');
      const uriMatches = content.match(uriPattern);
      if (uriMatches) {
        replacedCount += uriMatches.length;
        content = content.replace(uriPattern, 'rbxassetid://' + cleanNew);
      }

      if (isTextConfig) {
        // Also replace bare IDs in Lua tables such as { "DANCE NAME", 119311874202971 }.
        const bareIdPattern = new RegExp('(?<!\\d)' + cleanOld + '(?!\\d)', 'g');
        const bareMatches = content.match(bareIdPattern);
        if (bareMatches) {
          replacedCount += bareMatches.length;
          content = content.replace(bareIdPattern, cleanNew);
        }
      }
    }

    const outputBuffer = Buffer.from(content, isTextConfig ? 'utf8' : 'latin1');
    res.setHeader('Content-Disposition', 'attachment; filename="patched_' + filename + '"');
    res.setHeader('Content-Type', ext === '.rbxmx' ? 'application/xml' : (isTextConfig ? 'text/plain; charset=utf-8' : 'application/octet-stream'));
    res.setHeader('X-Replaced-Count', String(replacedCount));
    return res.send(outputBuffer);
  });
});

app.use((err, _req, res, _next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Terjadi kesalahan server.' });
});

// Railway assigns one port through process.env.PORT. Listen only on that port.
app.listen(PRIMARY_PORT, '0.0.0.0', () => {
  console.log(`Bulk Animation Dashboard berjalan di 0.0.0.0:${PRIMARY_PORT}`);
});
