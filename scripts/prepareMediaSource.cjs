const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const media = require(path.join(root, 'config', 'media-compliance.json')).ffmpeg;
const source = media.sourceBundle;
const principalOnly = process.argv.includes('--principal-only');
const outputRoot = path.resolve(root, 'artifacts', 'ffmpeg-source');
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neonvix-ffmpeg-source-'));
const downloadsRoot = path.join(workRoot, 'downloads');
const stagingRoot = path.join(workRoot, 'bundle');

function sha256(filePath) {
  // Stream in chunks: readFileSync cannot load files larger than 2 GiB.
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function download(url, destination, redirectsRemaining = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Neonvix-media-source-preparer' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining === 0) return reject(new Error(`Too many redirects for ${url}.`));
        return resolve(download(new URL(response.headers.location, url).toString(), destination, redirectsRemaining - 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Source download failed with HTTP ${response.statusCode}: ${url}`));
      }
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    });
    request.setTimeout(120_000, () => request.destroy(new Error(`Source download timed out: ${url}`)));
    request.on('error', reject);
  });
}

function collectFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.tar.xz'))
    .map(entry => path.join(directory, entry.name))
    .sort();
}

async function main() {
  if (!source?.components?.length) throw new Error('FFmpeg source components are not configured.');
  fs.mkdirSync(downloadsRoot, { recursive: true });
  fs.mkdirSync(stagingRoot, { recursive: true });

  const principalFiles = [];
  for (const component of source.components) {
    const destination = path.join(downloadsRoot, component.archiveName);
    await download(component.url, destination);
    const actualHash = sha256(destination);
    if (actualHash !== component.sha256) {
      throw new Error(`${component.name} SHA-256 mismatch. Expected ${component.sha256}; received ${actualHash}.`);
    }
    principalFiles.push({ ...component, filePath: destination, size: fs.statSync(destination).size });
  }

  let dependencyFiles = [];
  if (!principalOnly) {
    if (process.platform === 'win32') {
      throw new Error('Complete dependency-source collection requires bash, tar, and Docker on a Linux host. Use --principal-only only for local pin verification.');
    }
    const buildArchive = principalFiles.find(component => component.name === 'BtbN FFmpeg-Builds');
    if (!buildArchive) throw new Error('Pinned BtbN build-system source is missing.');
    const buildRoot = path.join(workRoot, 'build-system');
    fs.mkdirSync(buildRoot);
    run('unzip', ['-q', buildArchive.filePath, '-d', buildRoot]);
    const extractedRoot = fs.readdirSync(buildRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(buildRoot, entry.name))
      .find(candidate => fs.existsSync(path.join(candidate, 'download.sh')));
    if (!extractedRoot) throw new Error('BtbN source archive does not contain download.sh.');
    // On GitHub Actions BtbN derives its Docker image from GITHUB_REPOSITORY; pin it to BtbN's public images.
    run('bash', ['./download.sh'], { cwd: extractedRoot, env: { ...process.env, GITHUB_REPOSITORY: 'btbn/ffmpeg-builds' } });
    dependencyFiles = collectFiles(path.join(extractedRoot, '.cache', 'downloads'));
    if (dependencyFiles.length === 0) throw new Error('BtbN dependency-source collection produced no archives.');
  }

  const sourcesDir = path.join(stagingRoot, 'sources');
  const dependenciesDir = path.join(stagingRoot, 'dependencies');
  fs.mkdirSync(sourcesDir);
  fs.mkdirSync(dependenciesDir);
  for (const component of principalFiles) {
    fs.copyFileSync(component.filePath, path.join(sourcesDir, component.archiveName));
  }
  for (const dependencyPath of dependencyFiles) {
    fs.copyFileSync(dependencyPath, path.join(dependenciesDir, path.basename(dependencyPath)));
  }

  const evidence = {
    schemaVersion: 1,
    complete: !principalOnly,
    generatedAt: new Date().toISOString(),
    binaryVersion: media.binaryVersion,
    sourceRevision: media.sourceRevision,
    buildRelease: media.buildRelease,
    buildCommand: source.buildCommand,
    modifications: 'Neonvix does not modify FFmpeg or the pinned BtbN build recipes.',
    principalComponents: principalFiles.map(component => ({
      name: component.name,
      revision: component.revision,
      archiveName: component.archiveName,
      url: component.url,
      sha256: component.sha256,
      size: component.size,
    })),
    dependencies: dependencyFiles.map(filePath => ({
      archiveName: path.basename(filePath),
      sha256: sha256(filePath),
      size: fs.statSync(filePath).size,
    })),
  };

  fs.writeFileSync(path.join(stagingRoot, 'SOURCE_MANIFEST.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(path.join(stagingRoot, 'changes.diff'), 'No Neonvix modifications to FFmpeg or the pinned BtbN build recipes.\n');
  fs.writeFileSync(path.join(stagingRoot, 'BUILD_INFO.txt'), [
    `FFmpeg binary: ${media.binaryVersion}`,
    `FFmpeg revision: ${media.sourceRevision}`,
    `BtbN build release: ${media.buildRelease}`,
    `Build command: ${source.buildCommand}`,
    '',
    'The dependencies directory contains the source snapshots fetched by the pinned BtbN recipes.',
  ].join('\n'));

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.copyFileSync(path.join(stagingRoot, 'SOURCE_MANIFEST.json'), path.join(outputRoot, 'SOURCE_MANIFEST.json'));
  const artifactPath = path.join(outputRoot, principalOnly ? `INCOMPLETE-${source.artifactName}` : source.artifactName);
  run('tar', ['-czf', artifactPath, '-C', stagingRoot, '.']);
  fs.writeFileSync(`${artifactPath}.sha256`, `${sha256(artifactPath)}  ${path.basename(artifactPath)}\n`);
  console.log(principalOnly
    ? `Pinned principal sources verified; incomplete diagnostic artifact created at ${artifactPath}.`
    : `Complete FFmpeg corresponding-source artifact created at ${artifactPath}.`);
}

main().catch(error => {
  console.error(`Media source preparation failed: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});