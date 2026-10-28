// Prépare les fichiers de la détection / reconnaissance des visages à publier sur une release GitHub de photoboggan, où l'application les
// télécharge à la demande (voir src-tauri/src/face_models.rs) :
//
//   face_detection_yunet_2023mar.onnx      détection (OpenCV Zoo, MIT)
//   face_recognition_sface_2021dec.onnx    reconnaissance (OpenCV Zoo, Apache 2.0)
//   onnxruntime-<v>-win-x64.dll            ONNX Runtime Windows x64 (Microsoft, MIT), extrait de l'archive officielle
//   libonnxruntime-<v>-linux-x64.so        ONNX Runtime Linux x64 (Microsoft, MIT), extrait de l'archive officielle
//
// Les fichiers officiels sont téléchargés (ou repris du cache s'ils y sont déjà), vérifiés par leur SHA-256 figé ci-dessous, puis copiés dans
// dev_tools/face-models-release/ sous le nom à publier. Le manifeste src-tauri/face_models.json (noms, tailles, SHA-256, adresse de la release)
// est réécrit : il est compilé dans l'application.
//
// Ensuite : créer sur GitHub la release RELEASE_TAG et y téléverser les 4 fichiers de dev_tools/face-models-release/ (sans le sous-dossier downloads).
// Changer de version : modifier les URL et les sommes ci-dessous, et RELEASE_TAG (une release publiée ne doit plus changer).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_TAG = 'face-models-1';
const REPOSITORY = 'alexh3o/photoboggan';
const ORT_VERSION = '1.31.1';

// Fichiers officiels (source, SHA-256 de la source) et fichier publié (nom sur la release, nom local dans le dossier models/ de l'application).
const SOURCES = [
  {
    role: 'detector', platform: 'any', license: 'MIT',
    url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx',
    download: 'face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    asset: 'face_detection_yunet_2023mar.onnx', local: 'face_detection_yunet_2023mar.onnx',
  },
  {
    role: 'recognizer', platform: 'any', license: 'Apache-2.0',
    url: 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx',
    download: 'face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    asset: 'face_recognition_sface_2021dec.onnx', local: 'face_recognition_sface_2021dec.onnx',
  },
  {
    role: 'runtime', platform: 'windows-x86_64', license: 'MIT',
    url: `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-win-x64-${ORT_VERSION}.zip`,
    download: `onnxruntime-win-x64-${ORT_VERSION}.zip`,
    sha256: '5869e26bb25314375f2d5ef1877e3ea06b1543d6c710e6e4a1ec2f7177ab4b2c',
    member: `onnxruntime-win-x64-${ORT_VERSION}/lib/onnxruntime.dll`,
    asset: `onnxruntime-${ORT_VERSION}-win-x64.dll`, local: 'onnxruntime.dll',
  },
  {
    role: 'runtime', platform: 'linux-x86_64', license: 'MIT',
    url: `https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-x64-${ORT_VERSION}.tgz`,
    download: `onnxruntime-linux-x64-${ORT_VERSION}.tgz`,
    sha256: 'c849e36a1ef3e22d4ff217b9d1ce4a3cf5b9467b975610913ae959ad5b16bdc9',
    // Fichier réel (libonnxruntime.so et .so.1 sont des liens symboliques vers lui).
    member: `onnxruntime-linux-x64-${ORT_VERSION}/lib/libonnxruntime.so.${ORT_VERSION}`,
    asset: `libonnxruntime-${ORT_VERSION}-linux-x64.so`, local: 'libonnxruntime.so',
  },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, 'dev_tools', 'face-models-release');
const downloadDir = join(outputDir, 'downloads');
const manifestPath = join(root, 'src-tauri', 'face_models.json');

const sha256Of = path => createHash('sha256').update(readFileSync(path)).digest('hex');

async function fetchOnce(source) {
  const path = join(downloadDir, source.download);
  if (existsSync(path) && sha256Of(path) === source.sha256) {
    console.log(`déjà présent : ${source.download}`);
    return path;
  }
  console.log(`téléchargement : ${source.url}`);
  const response = await fetch(source.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${source.url} : HTTP ${response.status}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  const actual = sha256Of(path);
  if (actual !== source.sha256) {
    rmSync(path, { force: true });
    throw new Error(`${source.download} : SHA-256 inattendu (${actual})`);
  }
  return path;
}

// Windows : le tar du système (bsdtar) lit les zip et les tgz. Ailleurs : tar pour les tgz, unzip pour les zip.
function extractMember(archive, member, destination) {
  const work = mkdtempSync(join(tmpdir(), 'photoboggan-face-'));
  try {
    if (process.platform === 'win32') {
      const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      execFileSync(existsSync(systemTar) ? systemTar : 'tar', ['-xf', archive, '-C', work, member]);
    } else if (archive.endsWith('.zip')) {
      execFileSync('unzip', ['-q', archive, member, '-d', work]);
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', work, member]);
    }
    copyFileSync(join(work, member), destination);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

mkdirSync(downloadDir, { recursive: true });
const files = [];
for (const source of SOURCES) {
  const downloaded = await fetchOnce(source);
  const published = join(outputDir, source.asset);
  if (source.member) extractMember(downloaded, source.member, published);
  else copyFileSync(downloaded, published);
  files.push({
    role: source.role,
    platform: source.platform,
    asset: source.asset,
    local: source.local,
    size: statSync(published).size,
    sha256: sha256Of(published),
    license: source.license,
  });
  console.log(`prêt : ${source.asset}`);
}

const manifest = {
  release: RELEASE_TAG,
  base_url: `https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}/`,
  onnxruntime_version: ORT_VERSION,
  files,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nManifeste écrit : ${manifestPath}`);
console.log(`À publier sur la release « ${RELEASE_TAG} » de ${REPOSITORY} : les 4 fichiers de ${outputDir}`);
