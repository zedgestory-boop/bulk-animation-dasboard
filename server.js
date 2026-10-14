'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const app = express();
const PRIMARY_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const MAX_SCAN_SIZE = 200 * 1024 * 1024; // 200 MiB, scan only
const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20 MiB per Roblox upload
const MAX_BATCH_FILES = 1000;
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

  const configuredPassword = process.env.DASHBOARD_PASSWORD;
  // If no password is set in environment (e.g. initial setup or preview), allow access so user can configure variables
  if (!configuredPassword) {
    return next();
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
    apiKeyMasked: hasApiKey ? (process.env.ROBLOX_API_KEY.slice(0, 4) + '...' + process.env.ROBLOX_API_KEY.slice(-4)) : null,
    creatorType: groupId ? 'group' : (userId ? 'user' : 'none'),
    creatorId: groupId || userId || '',
    hasPassword,
    concurrencyDefault: 10,
    maxBatchFiles: MAX_BATCH_FILES
  });
});

app.get('/api/test-connection', async (_req, res) => {
  const apiKey = process.env.ROBLOX_API_KEY;
  if (!apiKey) {
    return res.status(400).json({
      connected: false,
      error: 'ROBLOX_API_KEY belum dikonfigurasi di Railway Variables atau .env'
    });
  }

  try {
    let creator;
    try {
      creator = getCreator();
    } catch (e) {
      return res.status(400).json({
        connected: false,
        error: e.message
      });
    }

    // Ping Roblox Assets API operation endpoint with the API key to test authentication
    const response = await fetch(`${ROBLOX_API}/operations/test-connection-check`, {
      headers: { 'x-api-key': apiKey }
    });

    // 404 or 403 or 400 means network reached Roblox; if 401/403 with invalid api key, report it
    if (response.status === 401) {
      return res.status(401).json({
        connected: false,
        error: 'Roblox API Key tidak valid atau kedaluwarsa. Periksa izin "Assets:read" dan "Assets:write".'
      });
    }

    return res.json({
      connected: true,
      message: 'Koneksi ke Roblox Open Cloud API berhasil!',
      creator: creator.creator,
      apiStatus: response.status
    });
  } catch (err) {
    return res.status(502).json({
      connected: false,
      error: `Gagal menghubungi Roblox API: ${err.message}`
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
  if (oType === 'group' && oId) return { creator: { groupId: oId } };
  if (oType === 'user' && oId) return { creator: { userId: oId } };

  const groupId = String(process.env.ROBLOX_GROUP_ID || '').trim();
  const userId = String(process.env.ROBLOX_USER_ID || '').trim();
  if (groupId) return { creator: { groupId } };
  if (userId) return { creator: { userId } };
  throw new Error('Isi ROBLOX_USER_ID atau ROBLOX_GROUP_ID di Railway Variables (.env) atau tentukan di panel.');
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
    headers: { 'x-api-key': apiKey }
  });
  return readRobloxResponse(response);
}

async function fetchRobloxAssetBuffer(assetId) {
  const cleanId = String(assetId || '').replace(/^rbxassetid:\/\//i, '').trim();
  if (!/^\d{5,20}$/.test(cleanId)) {
    throw new Error(`ID "${assetId}" bukan format Asset ID Roblox numerik yang valid.`);
  }

  const url = `https://assetdelivery.roblox.com/v2/assetId/${encodeURIComponent(cleanId)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Roblox/WinInet' }
  });
  if (!res.ok) {
    throw new Error(`Roblox Asset Delivery error: HTTP ${res.status}`);
  }
  const data = await res.json();
  const location = data?.locations?.[0]?.location;
  if (!location) {
    throw new Error(`Aset ID ${cleanId} tidak dapat diakses atau bukan aset publik.`);
  }

  const cdnRes = await fetch(location);
  if (!cdnRes.ok) {
    throw new Error(`Gagal mengunduh file aset dari CDN Roblox: HTTP ${cdnRes.status}`);
  }
  const arrayBuffer = await cdnRes.arrayBuffer();
  let buffer = Buffer.from(arrayBuffer);

  // Decompress gzip if present
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      buffer = zlib.gunzipSync(buffer);
    } catch (_) {}
  }

  return buffer;
}

async function uploadAnimationBuffer(buffer, filename, displayName, description, creatorContext, apiKey) {
  const form = new FormData();
  form.append('request', JSON.stringify({
    assetType: 'Animation',
    displayName: displayName || 'Animation Spoofed',
    description: description || 'Uploaded using Bulk Animation Dashboard',
    creationContext: creatorContext
  }));
  const ext = path.extname(filename).toLowerCase();
  const mimeType = ext === '.rbxm' || ext === '.rbxmx' ? 'model/x-rbxm' : 'application/octet-stream';
  form.append('fileContent', new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch(`${ROBLOX_API}/assets`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: form
  });
  const data = await readRobloxResponse(response);
  const operationPath = data.path || data.operationPath || '';
  let operationId = data.operationId || data.id || '';
  if (!operationId && operationPath) operationId = operationPath.split('/').filter(Boolean).pop();
  if (!operationId && data.assetId) {
    return { status: 'success', assetId: String(data.assetId), operationId: '', moderationState: data.moderationState || 'Unknown', response: data };
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
    moderationState: operation.response?.moderationState || operation.moderationState || 'Unknown',
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
    if (!['.fbx', '.rbxm', '.rbxmx'].includes(ext)) {
      return res.status(400).json({ error: 'Format yang diizinkan: .fbx, .rbxm, atau .rbxmx.' });
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

// Endpoint to fetch arbitrary Roblox Animation ID and spoof/re-upload to user's creator
app.post('/api/spoof-by-id', async (req, res) => {
  const apiKey = process.env.ROBLOX_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ROBLOX_API_KEY belum diatur di Railway Variables (.env).' });

  const rawId = String(req.body.assetId || '').trim();
  if (!rawId) return res.status(400).json({ error: 'Asset ID wajib diisi.' });

  const cleanId = rawId.replace(/^rbxassetid:\/\//i, '').trim();
  const displayName = String(req.body.displayName || `Spoofed_Anim_${cleanId}`).trim().slice(0, 50);
  const description = String(req.body.description || `Spoofed from original ID ${cleanId} via Bulk Animation Dashboard`).trim().slice(0, 1000);

  let creatorContext;
  try {
    creatorContext = getCreator(req.body.creatorType, req.body.creatorId);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    // 1. Fetch asset binary from Roblox Asset Delivery CDN
    const buffer = await fetchRobloxAssetBuffer(cleanId);
    if (!buffer || buffer.length === 0) {
      return res.status(404).json({ error: `Tidak ada data animasi yang dapat diunduh untuk ID ${cleanId}.` });
    }

    // 2. Upload the animation buffer to creator
    const filename = `anim_${cleanId}.rbxm`;
    const result = await uploadAnimationBuffer(buffer, filename, displayName, description, creatorContext, apiKey);

    const httpStatus = result.status === 'processing' ? 202 : 200;
    return res.status(httpStatus).json({
      ...result,
      oldAssetId: cleanId,
      originalUrl: `rbxassetid://${cleanId}`
    });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    return res.status(status).json({
      error: e.message || `Gagal melakukan spoofing untuk ID ${cleanId}`,
      oldAssetId: cleanId
    });
  }
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
    return res.json({ status: 'success', operationId: req.params.operationId, assetId: operation.response?.assetId || operation.assetId || null, moderationState: operation.response?.moderationState || operation.moderationState || 'Unknown', response: operation });
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

    const filename = req.file.originalname || 'animation.rbxm';
    const ext = path.extname(filename).toLowerCase();
    if (!['.rbxm', '.rbxmx'].includes(ext)) {
      return res.status(400).json({ error: 'Hanya file .rbxm dan .rbxmx yang didukung.' });
    }

    let content = req.file.buffer.toString('latin1');
    let replacedCount = 0;

    for (const [oldId, newId] of Object.entries(idMap)) {
      if (!oldId || !newId) continue;
      const cleanOld = String(oldId).trim();
      const cleanNew = String(newId).trim();
      const pattern = new RegExp(`rbxassetid://${cleanOld}`, 'g');
      const matches = content.match(pattern);
      if (matches) {
        replacedCount += matches.length;
        content = content.replace(pattern, `rbxassetid://${cleanNew}`);
      }
    }

    const outputBuffer = Buffer.from(content, 'latin1');
    res.setHeader('Content-Disposition', `attachment; filename="spoofed_${filename}"`);
    res.setHeader('Content-Type', ext === '.rbxmx' ? 'application/xml' : 'application/octet-stream');
    res.setHeader('X-Replaced-Count', String(replacedCount));
    return res.send(outputBuffer);
  });
});

app.use((err, _req, res, _next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Terjadi kesalahan server.' });
});

const PORTS = [...new Set([PRIMARY_PORT, 8080, 3000])];

PORTS.forEach(p => {
  try {
    app.listen(p, '0.0.0.0', () => console.log(`Bulk Animation Dashboard berjalan di port ${p}`));
  } catch (err) {
    console.warn(`Gagal bind ke port ${p}:`, err.message);
  }
});
