/**
 * Optional S3-compatible object storage for generated files (Tigris on Fly).
 *
 * Enabled when manager.s3.bucket is set in config; otherwise the manager
 * falls back to writing genDir on local disk (the docker-compose setup,
 * where nginx serves that directory from a shared volume).
 *
 * Why this exists: Fly Volumes are per-Machine and unshared, so the
 * "manager writes / nginx reads" pattern cannot work there. Files go to a
 * public bucket instead and manager.genUrl points at it.
 *
 * Credentials, endpoint and region come from the standard AWS env vars
 * (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3,
 * AWS_REGION), which the SDK reads natively. On Fly these are app secrets
 * holding a key scoped to the generated-files bucket ONLY.
 */
import config from 'config';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

let client = null;
let bucket = null;
let prefix = '';

if (config.has('manager.s3.bucket') && config.get('manager.s3.bucket')) {
  bucket = config.get('manager.s3.bucket');
  prefix = config.has('manager.s3.prefix') ? config.get('manager.s3.prefix') : '';
  client = new S3Client({});
  console.log(`[Storage] Generated files -> s3://${bucket}/${prefix}`);
}

export function storageEnabled() {
  return client !== null;
}

export async function putGenerated(key, buffer, contentType) {
  const fullKey = prefix ? `${prefix}/${key}` : key;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: fullKey,
    Body: buffer,
    ContentType: contentType
  }));
}
