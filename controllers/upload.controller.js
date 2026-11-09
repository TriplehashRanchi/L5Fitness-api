/**
 * Upload flow (the file itself never passes through this API):
 *   1. POST /uploads               → we save a "pending" row and return a signed upload URL
 *   2. the app PUTs the file to that URL, straight to storage
 *   3. POST /uploads/:id/complete  → we check the file really arrived, then mark it "ready"
 *   4. GET  /uploads               → the user's files, each with a signed download URL
 */
const crypto = require('node:crypto');

const uploads = require('../models/upload.model');
const storage = require('../services/storage');
const { HttpError } = require('../middleware/errors');

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadOwned(req) {
  const upload = UUID_RE.test(req.params.id) ? await uploads.findForUser(req.params.id, req.user.id) : null;
  if (!upload) throw new HttpError(404, 'UPLOAD_NOT_FOUND', 'File not found.');
  return upload;
}

async function create(req, res) {
  const contentType = typeof req.body?.contentType === 'string' ? req.body.contentType.toLowerCase() : '';
  const extension = ALLOWED_TYPES[contentType];
  if (!extension)
    throw new HttpError(400, 'UNSUPPORTED_TYPE', 'Only JPG, PNG, WebP or HEIC images can be uploaded.');

  const size = req.body?.size;
  if (!Number.isInteger(size) || size <= 0)
    throw new HttpError(400, 'INVALID_SIZE', 'File size is missing.');
  if (size > MAX_SIZE) throw new HttpError(413, 'FILE_TOO_LARGE', 'The file is larger than 10 MB.');

  // The key is generated here, never taken from the client, and always sits in the user's folder.
  const key = `users/${req.user.id}/${crypto.randomUUID()}.${extension}`;
  const upload = await uploads.create({ userId: req.user.id, key, contentType, size });
  const url = await storage.signUpload(key, { contentType, size });

  res.status(201).json({
    upload,
    uploadUrl: url,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    expiresIn: storage.UPLOAD_URL_TTL,
  });
}

async function complete(req, res) {
  const upload = await loadOwned(req);
  const stored = await storage.stat(upload.key);
  if (!stored) throw new HttpError(409, 'NOT_UPLOADED', 'The file has not been uploaded yet.');

  const ready = await uploads.markReady(upload.id, req.user.id, stored.size);
  res.json({ upload: { ...ready, url: await storage.signDownload(ready.key) } });
}

async function list(req, res) {
  const rows = await uploads.listForUser(req.user.id);
  const withUrls = await Promise.all(
    rows.map(async (row) => ({ ...row, url: await storage.signDownload(row.key) }))
  );
  res.json({ uploads: withUrls, urlExpiresIn: storage.DOWNLOAD_URL_TTL });
}

async function remove(req, res) {
  const upload = await loadOwned(req);
  // Delete the file first: if that fails the row stays and the delete can be retried.
  await storage.remove(upload.key);
  await uploads.remove(upload.id, req.user.id);
  res.status(204).end();
}

module.exports = { create, complete, list, remove };
