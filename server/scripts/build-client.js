// Bundles the Vercel Blob browser uploader into public/vendor/blob-upload.js (served from our own domain,
// so the admin console loads no third-party scripts). Exposes window.BlobUpload.upload(...).
import path from 'node:path';
import { build } from 'esbuild';
import { ROOT } from '../config.js';

const out = path.join(ROOT, 'public', 'vendor', 'blob-upload.js');
await build({
  stdin: { contents: "import { upload } from '@vercel/blob/client'; window.BlobUpload = { upload };", resolveDir: ROOT, loader: 'js' },
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['es2019'], outfile: out, logLevel: 'warning'
});
console.log('Blob uploader →', path.relative(ROOT, out));
