import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Settlement Engine imports and uses shared genReqId utility', (t) => {
  const indexPath = path.resolve(__dirname, './index.ts');
  const content = fs.readFileSync(indexPath, 'utf-8');
  
  t.ok(content.includes('genReqId'), 'index.ts should reference genReqId');
  t.match(content, /import\s+{[^}]*genReqId[^}]*}\s+from\s+['"]@bettapay\/validation['"]/s, 'index.ts should import genReqId from @bettapay/validation');
  t.match(content, /genReqId/s, 'index.ts should reference genReqId in Fastify configuration');
  t.end();
});

test('Settlement Engine configures BullMQ Redis retry options', (t) => {
  const indexPath = path.resolve(__dirname, './index.ts');
  const content = fs.readFileSync(indexPath, 'utf-8');

  t.match(content, /maxRetriesPerRequest:\s*env\.REDIS_MAX_RETRIES/s, 'BullMQ max retries should come from REDIS_MAX_RETRIES');
  t.match(content, /enableReadyCheck:\s*false/s, 'BullMQ should disable Redis ready checks for compatibility');
  t.match(content, /retryStrategy:\s*\(times:\s*number\)/s, 'BullMQ should configure an explicit retryStrategy');
  t.match(content, /Math\.min\(times \* 1000,\s*30000\)/s, 'retryStrategy should cap reconnect delay');
  t.end();
});
