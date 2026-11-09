// Prepares the files of the semantic search (SigLIP 2) to publish on a photoboggan GitHub release, where the application
// downloads them on demand:
//
//   siglip2-base-p16-224-vision-fp16.onnx   vision encoder, fp16 (ONNX conversion by onnx-community of the Google weights, Apache 2.0)
//   siglip2-base-p16-224-text-fp16.onnx     text encoder, fp16 (same conversion)
//   siglip2-base-p16-224-tokenizer.json     tokenizer (Google, Apache 2.0)
//   siglip2-base-p16-224-NOTICE.txt         licence notice and source revisions (generated here)
//
// ONNX Runtime is NOT handled here: it is already published with the face models (src-tauri/face_models.json) and shared.
//
// Each official file is taken from the local Hugging Face cache or from the download folder if already there, otherwise downloaded;
// it is checked against the pinned size and SHA-256 below (the script stops on any mismatch), then copied into
// dev_tools/semantic-models-release/ under the name to publish. The manifest src-tauri/semantic_models.json (names, sizes, SHA-256,
// release address, model constants) is rewritten: it is compiled into the application.
//
// Then: create the GitHub release RELEASE_TAG and upload the 4 files of dev_tools/semantic-models-release/ (not the downloads subfolder).
// To change a version: edit the URLs, sizes and sums below, and RELEASE_TAG (a published release must never change).

import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_TAG = 'semantic-models-1';
const REPOSITORY = 'alexh3o/photoboggan';

const MODEL_ID = 'siglip2-base-p16-224';
const ONNX_REPO = 'onnx-community/siglip2-base-patch16-224-ONNX';
const ONNX_REVISION = 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4';
const GOOGLE_REPO = 'google/siglip2-base-patch16-224';
const GOOGLE_REVISION = '75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2';

const NOTICE_ASSET = `${MODEL_ID}-NOTICE.txt`;

// Official files (source, size and SHA-256 of the source) and published file (name on the release, local name in the app's models folder).
// `hfPath` is the path inside the Hugging Face repository, used to look the file up in the local Hugging Face cache.
const SOURCES = [
  {
    role: 'vision',
    repo: ONNX_REPO, revision: ONNX_REVISION, hfPath: 'onnx/vision_model_fp16.onnx',
    size: 186039516,
    sha256: 'a1959f7bd3993a607e48839f6d01e25b876fe76afda301b028b78eef68aabd95',
    asset: `${MODEL_ID}-vision-fp16.onnx`, local: 'vision.onnx',
  },
  {
    role: 'text',
    repo: ONNX_REPO, revision: ONNX_REVISION, hfPath: 'onnx/text_model_fp16.onnx',
    size: 564862230,
    sha256: '711da56ada0a4aa11c7dd3320df741081a3cae4f0ae1b5e5c6d5b294738d0eb0',
    asset: `${MODEL_ID}-text-fp16.onnx`, local: 'text.onnx',
  },
  {
    role: 'tokenizer',
    repo: GOOGLE_REPO, revision: GOOGLE_REVISION, hfPath: 'tokenizer.json',
    size: 34363039,
    sha256: 'cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322',
    asset: `${MODEL_ID}-tokenizer.json`, local: 'tokenizer.json',
  },
].map(source => ({
  ...source,
  license: 'Apache-2.0',
  // Pinned by revision, never by branch name.
  url: `https://huggingface.co/${source.repo}/resolve/${source.revision}/${source.hfPath}`,
  download: `${source.repo.replace('/', '--')}--${source.revision.slice(0, 8)}--${source.hfPath.replace('/', '--')}`,
}));

// The model constants read from the checkpoint (phase 0, spec §15.1). logit_scale is already exponentiated.
const MODEL = {
  id: MODEL_ID,
  label: 'SigLIP 2 base (224 px)',
  image_size: 224,
  embed_dim: 768,
  mean: [0.5, 0.5, 0.5],
  std: [0.5, 0.5, 0.5],
  max_text_tokens: 64,
  lowercase: true,
  logit_scale: 112.6689,
  logit_bias: -16.7717,
  template: 'this is a photo of {}.',
  template_max_words: 3,
  pad_id: 0,
  eos_id: 1,
};

const NOTICE = `SigLIP 2 base patch16 224 - model files redistributed by photoboggan

Model: SigLIP 2 (ViT-B/16, 224 px), by Google.
Licence: Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)
Source of the weights and of the tokenizer: https://huggingface.co/${GOOGLE_REPO}
  revision ${GOOGLE_REVISION}
ONNX conversion (fp16 vision and text encoders): onnx-community, https://huggingface.co/${ONNX_REPO}
  revision ${ONNX_REVISION}
  (conversion of the Apache 2.0 Google weights; the repository declares no licence of its own)

Files in this release:
${SOURCES.map(s => `  ${s.asset}  <-  ${s.url}`).join('\n')}

These files are unmodified copies of the sources above, renamed. Their SHA-256 sums are pinned in the application manifest
(semantic_models.json) and checked at download time.

Licensed under the Apache License, Version 2.0; you may not use these files except in compliance with the License.
Unless required by applicable law or agreed to in writing, they are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
OR CONDITIONS OF ANY KIND, either express or implied.
`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, 'dev_tools', 'semantic-models-release');
const downloadDir = join(outputDir, 'downloads');
const manifestPath = join(root, 'src-tauri', 'semantic_models.json');
const hfCacheDir = join(process.env.HF_HUB_CACHE ?? join(process.env.HF_HOME ?? join(homedir(), '.cache', 'huggingface'), 'hub'));

// Streamed hash: the files are too big to read into memory comfortably.
const sha256Of = path => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});

async function matches(path, source) {
  return existsSync(path) && statSync(path).size === source.size && (await sha256Of(path)) === source.sha256;
}

async function obtain(source) {
  // 1. Download folder of this script.
  const cached = join(downloadDir, source.download);
  if (await matches(cached, source)) {
    console.log(`already present: ${source.download}`);
    return cached;
  }
  // 2. Local Hugging Face cache (same pinned revision).
  const hfFile = join(hfCacheDir, `models--${source.repo.replace('/', '--')}`, 'snapshots', source.revision, ...source.hfPath.split('/'));
  if (await matches(hfFile, source)) {
    console.log(`reused from the Hugging Face cache: ${source.hfPath}`);
    return hfFile;
  }
  // 3. Download.
  console.log(`downloading: ${source.url}`);
  const response = await fetch(source.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
  writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  if (!(await matches(cached, source))) {
    const actual = statSync(cached).size;
    rmSync(cached, { force: true });
    throw new Error(`${source.download}: unexpected size or SHA-256 (got ${actual} bytes, expected ${source.size})`);
  }
  return cached;
}

mkdirSync(downloadDir, { recursive: true });
const files = [];
for (const source of SOURCES) {
  const obtained = await obtain(source);
  const published = join(outputDir, source.asset);
  copyFileSync(obtained, published);
  // Re-check the published copy: this is what gets uploaded.
  if (!(await matches(published, source))) throw new Error(`${source.asset}: copy does not match the pinned size / SHA-256`);
  files.push({
    role: source.role,
    asset: source.asset,
    local: source.local,
    size: statSync(published).size,
    sha256: await sha256Of(published),
    license: source.license,
    source_url: source.url,
  });
  console.log(`ready: ${source.asset}`);
}

// The notice is generated text, so its size and hash are computed rather than pinned.
const noticePath = join(outputDir, NOTICE_ASSET);
writeFileSync(noticePath, NOTICE);
files.push({
  role: 'notice',
  asset: NOTICE_ASSET,
  local: 'NOTICE.txt',
  size: statSync(noticePath).size,
  sha256: await sha256Of(noticePath),
  license: 'Apache-2.0',
  source_url: `https://huggingface.co/${GOOGLE_REPO}/tree/${GOOGLE_REVISION}`,
});
console.log(`ready: ${NOTICE_ASSET}`);

const manifest = {
  release: RELEASE_TAG,
  base_url: `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/`,
  models: [{ ...MODEL, files }],
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nManifest written: ${manifestPath}`);
console.log(`To publish on the release "${RELEASE_TAG}" of ${REPOSITORY}: the ${files.length} files of ${outputDir} (not the downloads subfolder)`);
