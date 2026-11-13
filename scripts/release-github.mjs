import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  artifactDetails,
  boundedNotes,
  buildReleaseManifest,
  manifestAssetName,
  parseDesktopArgument,
  safeAssetName,
  safeTag,
} from './release-tooling.mjs';

const usage = `Usage:
  node scripts/release-github.mjs [--apk <path> | --build] [options]

Builds release-manifest.json and a checksum from a signed Android APK. Without
--publish it only writes local files and prints the GitHub command. Run from the
repository root.

Options:
  --apk <path>          Signed release APK. Defaults to the --release build path.
  --build               Run npm run android:build -- --release first.
  --notes <text>        Bounded release notes. Defaults to a generated line.
  --notes-file <path>   Read release notes from a file instead.
  --tag <tag>           Release tag. Defaults to android-<version>-<code>.
  --channel <name>      stable (default) or beta.
  --desktop <p>=<path>  Optional desktop artifact; repeat for each platform.
  --repo <owner/name>   GitHub repository. Defaults to Errantial/personal-hub.
  --output-dir <path>   Staging directory. Defaults to .artifacts/release.
  --publish             Create or update the GitHub release with gh.
  --help                Show this message.

The production signing key and its passwords remain environment-only. The
script never reads, prints or stores them.`;
const defaultRepo = 'Errantial/personal-hub';

function value(args, index, flag) {
  const result = args[index];
  if (!result || result.startsWith('--'))
    throw new Error(`${flag} needs a value.`);
  return result;
}

function parseArguments(args) {
  const options = {
    publish: false,
    build: false,
    desktop: [],
    channel: 'stable',
    repo: defaultRepo,
    outputDir: '.artifacts/release',
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') {
      console.log(usage);
      process.exit(0);
    }
    if (argument === '--publish') {
      options.publish = true;
      continue;
    }
    if (argument === '--build') {
      options.build = true;
      continue;
    }
    if (argument === '--apk') {
      options.apk = value(args, (index += 1), '--apk');
      continue;
    }
    if (argument === '--notes') {
      options.notes = value(args, (index += 1), '--notes');
      continue;
    }
    if (argument === '--notes-file') {
      options.notesFile = value(args, (index += 1), '--notes-file');
      continue;
    }
    if (argument === '--tag') {
      options.tag = value(args, (index += 1), '--tag');
      continue;
    }
    if (argument === '--channel') {
      options.channel = value(args, (index += 1), '--channel');
      continue;
    }
    if (argument === '--repo') {
      options.repo = value(args, (index += 1), '--repo');
      continue;
    }
    if (argument === '--output-dir') {
      options.outputDir = value(args, (index += 1), '--output-dir');
      continue;
    }
    if (argument === '--desktop') {
      options.desktop.push(value(args, (index += 1), '--desktop'));
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (options.apk && options.build)
    throw new Error('Choose --apk or --build, not both.');
  if (options.notes && options.notesFile)
    throw new Error('Choose --notes or --notes-file, not both.');
  if (options.channel !== 'stable' && options.channel !== 'beta')
    throw new Error('Use --channel stable or --channel beta.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo))
    throw new Error('Use --repo <owner>/<name>.');
  return options;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function requireCleanTree() {
  const status = git('status', '--porcelain');
  if (status) throw new Error('Commit or stash changes before a release.');
}

function packageVersion() {
  return JSON.parse(readFileSync('package.json', 'utf8')).version;
}

function findApksigner() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdk || !existsSync(sdk))
    throw new Error(
      'Set ANDROID_HOME or ANDROID_SDK_ROOT so the signed APK can be verified before publishing.',
    );
  const tools = join(sdk, 'build-tools');
  if (!existsSync(tools))
    throw new Error('The Android SDK build-tools directory is missing.');
  const latest = readdirSync(tools)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (!latest) throw new Error('The Android SDK has no build-tools.');
  return join(
    tools,
    latest,
    process.platform === 'win32' ? 'apksigner.bat' : 'apksigner',
  );
}

function verifySignature(apk) {
  const apksigner = findApksigner();
  const result =
    process.platform === 'win32'
      ? spawnSync(
          'cmd.exe',
          ['/d', '/c', `"${apksigner}" verify --print-certs "${apk}"`],
          { encoding: 'utf8' },
        )
      : spawnSync(apksigner, ['verify', '--print-certs', apk], {
          encoding: 'utf8',
        });
  if (result.status !== 0)
    throw new Error(
      `APK signature verification failed: ${(result.stderr || result.stdout || '').trim()}`,
    );
  const fingerprint = /certificate SHA-256 digest:\s*([0-9a-f:]+)/i.exec(
    result.stdout,
  )?.[1];
  console.log(
    `APK signature verified${fingerprint ? ` (certificate SHA-256 ${fingerprint})` : ''}.`,
  );
}

function releaseExists(tag, repo) {
  const result = spawnSync(
    'gh',
    ['release', 'view', tag, '--repo', repo, '--json', 'tagName'],
    { encoding: 'utf8' },
  );
  if (result.status === 0) return true;
  const message = `${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/not found|HTTP 404/i.test(message)) return false;
  throw new Error(
    `Could not inspect the GitHub release: ${message.trim().split('\n').at(-1) ?? 'unknown gh error'}`,
  );
}

function remoteTagSha(tag) {
  const output = execFileSync(
    'git',
    ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`],
    { encoding: 'utf8' },
  ).trim();
  if (!output) return null;
  const lines = output.split('\n').map((line) => line.split(/\s+/));
  const peeled = lines.find((line) => line[1]?.endsWith('^{}'));
  const direct = lines.find((line) => !line[1]?.endsWith('^{}'));
  return (peeled ?? direct)?.[0] ?? null;
}

function gh(...args) {
  console.log(`gh ${args.join(' ')}`);
  execFileSync('gh', args, { stdio: 'inherit' });
}

function copyArtifact(source, destination) {
  if (resolve(source) !== resolve(destination))
    copyFileSync(source, destination);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = git('rev-parse', '--show-toplevel');
  if (resolve(root) !== resolve(process.cwd()))
    throw new Error('Run this script from the repository root.');
  requireCleanTree();
  const versionCode = Number(git('rev-list', '--count', 'HEAD'));
  const short = git('rev-parse', '--short=7', 'HEAD');
  const version = packageVersion();
  const versionName = `${version}+${short}`;
  const tag = options.tag ?? `android-${version}-${versionCode}`;
  if (!safeTag(tag))
    throw new Error(
      'Use a tag with letters, numbers, dots, plus, underscore or hyphen.',
    );
  if (options.build) {
    console.log('Building the signed release APK...');
    execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : 'npm',
      process.platform === 'win32'
        ? ['/d', '/c', 'npm', 'run', 'android:build', '--', '--release']
        : ['run', 'android:build', '--', '--release'],
      { stdio: 'inherit' },
    );
  }
  const apkName = `personal-hub-${versionName}.apk`;
  const apk = resolve(options.apk ?? `.artifacts/android/${apkName}`);
  if (!existsSync(apk)) throw new Error(`The release APK is missing: ${apk}`);
  if (basename(apk) !== apkName)
    throw new Error(
      `The APK must be named ${apkName}, the name the signed release build produces.`,
    );
  const android = await artifactDetails(apk, apkName);
  const notes =
    options.notes ??
    (options.notesFile
      ? readFileSync(options.notesFile, 'utf8')
      : `Personal Hub ${versionName}.\n\nVerify the APK SHA-256 before installing.`);
  const desktop = [];
  const desktopSources = [];
  for (const value of options.desktop) {
    const parsed = parseDesktopArgument(value);
    const source = resolve(parsed.path);
    if (!existsSync(source))
      throw new Error(`The desktop artifact is missing: ${source}`);
    const details = await artifactDetails(source, basename(source));
    if (!safeAssetName(details.name))
      throw new Error(`The desktop asset name is not safe: ${details.name}`);
    desktop.push({ platform: parsed.platform, ...details });
    desktopSources.push({ source, name: details.name });
  }
  const manifest = buildReleaseManifest({
    repo: options.repo,
    tag,
    channel: options.channel,
    versionName,
    versionCode,
    notes,
    android,
    desktop,
  });
  if (options.publish) verifySignature(apk);

  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const stagedApk = join(outputDir, apkName);
  copyArtifact(apk, stagedApk);
  const checksum = join(outputDir, `${apkName}.sha256`);
  writeFileSync(checksum, `${android.sha256}  ${apkName}\n`);
  const manifestPath = join(outputDir, manifestAssetName);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const notesPath = join(outputDir, 'release-notes.txt');
  writeFileSync(notesPath, `${boundedNotes(notes)}\n`);
  const desktopPaths = [];
  for (const asset of desktopSources) {
    const destination = join(outputDir, asset.name);
    if (existsSync(destination) && resolve(asset.source) !== destination)
      throw new Error(`Two release assets share the name ${asset.name}.`);
    copyArtifact(asset.source, destination);
    desktopPaths.push(destination);
  }
  console.log(`Tag: ${tag}`);
  console.log(`Version: ${versionName} (code ${versionCode})`);
  console.log(`APK: ${stagedApk}`);
  console.log(`SHA-256: ${android.sha256}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));

  const assets = [stagedApk, checksum, manifestPath, ...desktopPaths];
  if (!options.publish) {
    console.log('\nDry run. No GitHub release was created or changed.');
    console.log(
      `Run the same command with --publish to upload ${assets.length} asset(s) to ${options.repo}.`,
    );
    return;
  }

  const head = git('rev-parse', 'HEAD');
  const localTag = spawnSync(
    'git',
    ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`],
    { encoding: 'utf8' },
  );
  if (localTag.status === 0 && localTag.stdout.trim() !== head)
    throw new Error(`The local tag ${tag} does not point to HEAD.`);
  const remote = remoteTagSha(tag);
  if (remote && remote !== head)
    throw new Error(`The remote tag ${tag} does not point to HEAD.`);
  const exists = releaseExists(tag, options.repo);
  const flags =
    options.channel === 'beta'
      ? ['--prerelease']
      : ['--latest', '--prerelease=false'];
  if (!exists) {
    gh(
      'release',
      'create',
      tag,
      ...assets,
      '--repo',
      options.repo,
      '--target',
      head,
      '--title',
      `Personal Hub ${versionName}`,
      '--notes-file',
      notesPath,
      ...flags,
    );
  } else {
    gh(
      'release',
      'upload',
      tag,
      ...assets,
      '--repo',
      options.repo,
      '--clobber',
    );
    gh(
      'release',
      'edit',
      tag,
      '--repo',
      options.repo,
      '--title',
      `Personal Hub ${versionName}`,
      '--notes-file',
      notesPath,
      '--draft=false',
      ...flags,
    );
  }
  console.log(`GitHub release ${exists ? 'updated' : 'created'}: ${tag}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(
      `Release failed: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
