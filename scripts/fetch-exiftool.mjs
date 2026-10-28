// Télécharge la distribution officielle d'ExifTool dans src-tauri/vendor/exiftool/, embarquée dans l'application (ressource Tauri « exiftool »,
// voir tauri.conf.json et src-tauri/src/exiftool.rs). Les binaires ne sont pas versionnés : ce script les récupère, vérifie leur somme SHA-256
// (figée ci-dessous) et ne refait rien si la bonne version est déjà en place.
//
//   Windows : exiftool-<version>_64.zip (Perl embarqué) -> exiftool.exe + exiftool_files/
//   Linux / macOS : Image-ExifTool-<version>.tar.gz (Perl pur, lancé par le perl du système) -> exiftool + lib/
//
// Options : --optional (en cas d'échec, avertit sans faire échouer la commande : utilisé par `tauri dev`, l'application cherche alors
// ExifTool dans le PATH), --platform=win32|linux|darwin (distribution d'une autre plateforme que celle de la machine).
//
// Changer de version : modifier VERSION et les deux sommes, prises dans https://exiftool.org/checksums.txt (lignes « SHA2-256 »).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '13.59';
const DISTRIBUTIONS = {
  windows: {
    file: `exiftool-${VERSION}_64.zip`,
    sha256: '44b512b25af500724ba579d0a53c8fc5851628b692dd5e5d94ae4a15c2cba9ec',
  },
  perl: {
    file: `Image-ExifTool-${VERSION}.tar.gz`,
    sha256: '668ea3acececb7235fbd0f4900e72d5f12c9b07e5c778fd36cb1e9b5828fd65a',
  },
};
// Les archives sont hébergées sur SourceForge (exiftool.org ne publie que la dernière version et les sommes de contrôle).
const downloadUrl = file => `https://sourceforge.net/projects/exiftool/files/${file}/download`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src-tauri', 'vendor', 'exiftool');
const stampFile = join(target, '.version');
// Fichier versionné du dossier (le dossier doit exister pour que la compilation Rust trouve la ressource) : jamais supprimé.
const KEPT_FILES = new Set(['README.txt']);

const args = process.argv.slice(2);
const optional = args.includes('--optional');
const platform = args.find(arg => arg.startsWith('--platform='))?.split('=')[1] ?? process.platform;
const variant = platform === 'win32' ? 'windows' : 'perl';
const distribution = DISTRIBUTIONS[variant];
const stamp = `${variant} ${VERSION}`;

// Windows : le tar du système (bsdtar) sait lire les zip, contrairement au tar GNU que Git Bash peut placer avant lui dans le PATH.
function tarProgram() {
  if (process.platform !== 'win32') return 'tar';
  const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(systemTar) ? systemTar : 'tar';
}

function clearTarget() {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(target)) {
    if (!KEPT_FILES.has(name)) rmSync(join(target, name), { recursive: true, force: true });
  }
}

async function main() {
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp) {
    console.log(`ExifTool ${VERSION} (${variant}) déjà en place.`);
    return;
  }
  console.log(`Téléchargement d'ExifTool ${VERSION} (${distribution.file})…`);
  const response = await fetch(downloadUrl(distribution.file), { redirect: 'follow' });
  if (!response.ok) throw new Error(`téléchargement refusé (HTTP ${response.status})`);
  const archive = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(archive).digest('hex');
  if (sha256 !== distribution.sha256) throw new Error(`somme SHA-256 inattendue (${sha256}) : archive refusée`);

  const work = mkdtempSync(join(tmpdir(), 'photoboggan-exiftool-'));
  try {
    const archivePath = join(work, distribution.file);
    writeFileSync(archivePath, archive);
    const extracted = join(work, 'extracted');
    mkdirSync(extracted);
    execFileSync(tarProgram(), ['-xf', archivePath, '-C', extracted], { stdio: 'inherit' });
    const [folder] = readdirSync(extracted);
    const source = join(extracted, folder);

    clearTarget();
    if (variant === 'windows') {
      // « exiftool(-k).exe » attend une touche avant de se fermer ; renommé « exiftool.exe », il ne le fait plus.
      cpSync(join(source, 'exiftool(-k).exe'), join(target, 'exiftool.exe'));
      cpSync(join(source, 'exiftool_files'), join(target, 'exiftool_files'), { recursive: true });
    } else {
      cpSync(join(source, 'exiftool'), join(target, 'exiftool'));
      cpSync(join(source, 'lib'), join(target, 'lib'), { recursive: true });
      cpSync(join(source, 'README'), join(target, 'README'));
      chmodSync(join(target, 'exiftool'), 0o755);
    }
    writeFileSync(stampFile, `${stamp}\n`);
    console.log(`ExifTool ${VERSION} installé dans ${target}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`ExifTool n'a pas pu être récupéré : ${error.message}`);
  if (!optional) process.exit(1);
  console.warn("Suite sans version embarquée : l'application utilisera l'exiftool du PATH s'il existe.");
});
