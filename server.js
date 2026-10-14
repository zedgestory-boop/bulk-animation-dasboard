'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
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
  if (req.path === '/health') return next();

  const configuredPassword = process.env.DASHBOARD_PASSWORD;
  if (!configuredPassword) {
    return res.status(503).json({ error: 'DASHBOARD_PASSWORD belum diatur di Railway Variables.' });
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
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

function getCreator() {
  const userId = String(process.env.ROBLOX_USER_ID || '').trim();
  const groupId = String(process.env.ROBLOX_GROUP_ID || '').trim();
  if (groupId) return { creator: { groupId } };
  if (userId) return { creator: { userId } };
  throw new Error('Isi ROBLOX_USER_ID atau ROBLOX_GROUP_ID di Railway Variables.');
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

app.post('/api/upload-animation', (req, res) => {
  animationUpload.single('file')(req, res, async (err) => {
    if (multerError(err, res)) return;
    if (!req.file) return res.status(400).json({ error: 'Pilih satu file terlebih dahulu.' });

    const apiKey = process.env.ROBLOX_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ROBLOX_API_KEY belum diatur di Railway Variables.' });

    const filename = req.file.originalname || 'animation.fbx';
    const displayName = String(req.body.displayName || path.parse(filename).name).trim().slice(0, 50);
    const description = String(req.body.description || 'Uploaded using Bulk Animation Dashboard').trim().slice(0, 1000);
    const ext = path.extname(filename).toLowerCase();
    if (!['.fbx', '.rbxm', '.rbxmx'].includes(ext)) {
      return res.status(400).json({ error: 'Format yang diizinkan: .fbx, .rbxm, atau .rbxmx.' });
    }

    let creatorContext;
    try { creatorContext = getCreator(); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    try {
      const form = new FormData();
      form.append('request', JSON.stringify({
        assetType: 'Animation',
        displayName: displayName || 'Animation Upload',
        description,
        creationContext: creatorContext
      }));
      const mimeType = ext === '.rbxm' || ext === '.rbxmx' ? 'model/x-rbxm' : 'application/octet-stream';
      form.append('fileContent', new Blob([req.file.buffer], { type: mimeType }), filename);

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
        return res.json({ status: 'success', assetId: String(data.assetId), operationId: '', moderationState: data.moderationState || 'Unknown', response: data });
      }
      if (!operationId) {
        return res.status(502).json({ error: 'Roblox tidak mengembalikan operation ID. Periksa respons Roblox sebelum mengulang agar tidak membuat aset duplikat.', response: data, uncertain: true });
      }

      // Poll for up to 25 seconds. If still processing, return the operation ID so the UI can check later.
      let operation = null;
      for (let i = 0; i < 25; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try { operation = await getOperation(operationId); }
        catch (pollError) {
          if (pollError.status === 401 || pollError.status === 403) throw pollError;
          continue;
        }
        const done = operation.done === true || operation.status === 'Succeeded' || operation.status === 'Failed';
        if (done) break;
      }

      const isDone = operation && (operation.done === true || operation.status === 'Succeeded' || operation.status === 'Failed');
      if (!isDone) {
        return res.status(202).json({ status: 'processing', operationId, message: 'Roblox masih memproses aset. Jangan unggah ulang file ini dulu.' });
      }
      if (operation.error || operation.status === 'Failed') {
        return res.status(422).json({ status: 'failed', operationId, error: operation.error?.message || operation.error || 'Roblox gagal memproses aset.', response: operation });
      }
      const assetId = operation.response?.assetId || operation.assetId || data.assetId || null;
      return res.json({ status: 'success', assetId: assetId ? String(assetId) : null, operationId, moderationState: operation.response?.moderationState || operation.moderationState || 'Unknown', response: operation });
    } catch (e) {
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      return res.status(status).json({ error: e.message || 'Upload ke Roblox gagal.', details: e.details || null });
    }
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
    return res.json({ status: 'success', operationId: req.params.operationId, assetId: operation.response?.assetId || operation.assetId || null, moderationState: operation.response?.moderationState || operation.moderationState || 'Unknown', response: operation });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message || 'Gagal memeriksa status operasi Roblox.' });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ error: 'Terjadi kesalahan server.' });
});

app.listen(PORT, () => console.log(`Bulk Animation Dashboard berjalan di port ${PORT}`));
