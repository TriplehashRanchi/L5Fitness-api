/**
 * Object storage (Neon, S3-compatible).
 *
 * Files never pass through this API. The app asks for a short-lived signed URL, then uploads or
 * downloads straight to/from storage. The bucket is private, so every read needs a signed URL.
 */
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const env = require('../config/env');

const s3 = new S3Client({
  endpoint: env.s3Endpoint,
  region: env.s3Region,
  credentials: { accessKeyId: env.s3AccessKeyId, secretAccessKey: env.s3SecretAccessKey },
  forcePathStyle: true, // required: Neon uses path-style addressing
  // Keep signed URLs plain (no extra checksum parameters the uploader would have to match).
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const bucket = env.s3Bucket;

const UPLOAD_URL_TTL = 5 * 60; // seconds
const DOWNLOAD_URL_TTL = 60 * 60; // seconds

/** Signed PUT URL. The upload must use exactly this content type and size or storage rejects it. */
function signUpload(key, { contentType, size }) {
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: UPLOAD_URL_TTL, signableHeaders: new Set(['content-type', 'content-length']) }
  );
}

function signDownload(key) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: DOWNLOAD_URL_TTL,
  });
}

/** Returns { size, contentType } or null when the object is not there. */
async function stat(key) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: head.ContentLength, contentType: head.ContentType };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

const remove = (key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

const ping = () => s3.send(new HeadBucketCommand({ Bucket: bucket }));

module.exports = { bucket, signUpload, signDownload, stat, remove, ping, UPLOAD_URL_TTL, DOWNLOAD_URL_TTL };
