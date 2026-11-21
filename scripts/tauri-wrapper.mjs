// Wraps the Tauri CLI so that Windows `tauri build` runs merge-msi.ps1
// afterwards, combining per-language MSIs into one multi-language MSI.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauriCliPath = path.join(rootDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const args = process.argv.slice(2);

const buildStartedAt = Date.now();
const cliResult = spawnSync(process.execPath, [tauriCliPath, ...args], {
    stdio: 'inherit',
    cwd: rootDir,
});

if (cliResult.error) {
    console.error(`[tauri-wrapper] Failed to run Tauri CLI: ${cliResult.error.message}`);
    process.exit(1);
}

const cliExitCode = cliResult.status ?? 1;

function getFlagValue(argList, names) {
    for (let i = 0; i < argList.length; i++) {
        const arg = argList[i];
        for (const name of names) {
            if (arg === name && i + 1 < argList.length) {
                return argList[i + 1];
            }
            if (arg.startsWith(`${name}=`)) {
                return arg.slice(name.length + 1);
            }
        }
    }
    return null;
}

function shouldMergeMsi(argList) {
    if (process.platform !== 'win32') return false;
    const subcommand = argList.find((a) => !a.startsWith('-'));
    if (subcommand !== 'build') return false;
    if (argList.includes('--no-bundle')) return false;

    const bundles = getFlagValue(argList, ['--bundles', '-b']);
    if (bundles) {
        const list = bundles.split(',').map((s) => s.trim().toLowerCase());
        if (!list.includes('msi') && !list.includes('all')) return false;
    }
    return true;
}

if (shouldMergeMsi(args)) {
    const confPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');
    const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));

    const rawLangs = conf?.bundle?.windows?.wix?.language;
    const langs = Array.isArray(rawLangs)
        ? rawLangs
        : rawLangs && typeof rawLangs === 'object'
            ? Object.keys(rawLangs)
            : [];

    if (langs.length > 1) {
        const baseLang = langs.includes('en-US') ? 'en-US' : langs[0];
        const extraLangs = langs.filter((l) => l !== baseLang);

        const isDebug = args.includes('--debug') || args.includes('-d');
        const profile = isDebug ? 'debug' : 'release';
        const targetTriple = getFlagValue(args, ['--target', '-t']);

        const msiDir = targetTriple
            ? path.join(rootDir, 'src-tauri', 'target', targetTriple, profile, 'bundle', 'msi')
            : path.join(rootDir, 'src-tauri', 'target', profile, 'bundle', 'msi');

        const productName = conf.productName;
        const version = conf.version;
        const basePrefix = `${productName}_${version}_`;
        const baseSuffix = `_${baseLang}.msi`;

        // If `tauri build` returned a non-zero exit code (e.g. missing TAURI_SIGNING_PRIVATE_KEY
        // locally when createUpdaterArtifacts is true), still merge if fresh MSIs were produced.
        const hasFreshMsis = fs.existsSync(msiDir) && fs.readdirSync(msiDir).some((f) => {
            if (!f.startsWith(basePrefix) || !f.endsWith(baseSuffix)) return false;
            return fs.statSync(path.join(msiDir, f)).mtimeMs >= buildStartedAt - 2000;
        });

        if (cliExitCode === 0 || hasFreshMsis) {
            if (fs.existsSync(msiDir)) {
                const hadSigFiles = fs.readdirSync(msiDir).some((f) => f.startsWith(basePrefix) && f.endsWith('.msi.sig'));

                const psScript = path.join(rootDir, 'scripts', 'merge-msi.ps1');
                const mergeResult = spawnSync(
                    'powershell.exe',
                    [
                        '-NoProfile',
                        '-ExecutionPolicy',
                        'Bypass',
                        '-File',
                        psScript,
                        '-MsiDir',
                        msiDir,
                        '-ProductName',
                        productName,
                        '-Version',
                        version,
                        '-BaseLang',
                        baseLang,
                        '-ExtraLangs',
                        extraLangs.join(','),
                    ],
                    { stdio: 'inherit', cwd: rootDir }
                );

                if (mergeResult.error) {
                    console.error(`[tauri-wrapper] Failed to run merge-msi.ps1: ${mergeResult.error.message}`);
                    process.exit(1);
                }
                if (mergeResult.status !== 0) {
                    process.exit(mergeResult.status ?? 1);
                }

                // Re-sign the merged MSI if updater signing was active during the build
                if (hadSigFiles && process.env.TAURI_SIGNING_PRIVATE_KEY) {
                    const mergedFiles = fs
                        .readdirSync(msiDir)
                        .filter((f) => f.startsWith(basePrefix) && f.endsWith('.msi'));

                    for (const file of mergedFiles) {
                        const fullPath = path.join(msiDir, file);
                        console.log(`[tauri-wrapper] Re-signing merged MSI: ${file}`);
                        const signResult = spawnSync(process.execPath, [tauriCliPath, 'signer', 'sign', fullPath], {
                            stdio: 'inherit',
                            cwd: rootDir,
                        });
                        if (signResult.status !== 0) {
                            console.error(`[tauri-wrapper] Failed to sign ${file}`);
                            process.exit(signResult.status ?? 1);
                        }
                    }
                }
            }
        }
    }
}

if (cliExitCode !== 0) {
    process.exit(cliExitCode);
}
