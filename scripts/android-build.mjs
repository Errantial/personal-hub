import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join, basename } from 'node:path';

const args = process.argv.slice(2);
const test = args.includes('--test');
const release = args.includes('--release');
const originIndex = args.indexOf('--origin');
const origin =
  originIndex >= 0
    ? args[originIndex + 1]
    : test
      ? 'http://127.0.0.1:3011'
      : '';
if (test && release)
  throw new Error('Test connections cannot be packaged in release builds.');
let server;
try {
  server = new URL(origin);
} catch {
  throw new Error(
    'Use --origin https://your-server, or --test for the isolated emulator server.',
  );
}
if (
  server.username ||
  server.password ||
  server.pathname !== '/' ||
  server.search ||
  server.hash ||
  (server.protocol !== 'https:' &&
    !(test && server.protocol === 'http:' && server.hostname === '127.0.0.1'))
) {
  throw new Error(
    'Use --origin https://your-server, or --test for the isolated emulator server.',
  );
}
const sdk =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
    : undefined);
const javaRoot =
  process.platform === 'win32' ? 'C:/Program Files/Eclipse Adoptium' : '';
const bundledJava = existsSync(javaRoot)
  ? readdirSync(javaRoot).find((name) => name.startsWith('jdk-21.'))
  : undefined;
const java =
  process.env.ANDROID_JAVA_HOME ??
  (bundledJava ? join(javaRoot, bundledJava) : process.env.JAVA_HOME);
if (!sdk || !existsSync(sdk) || !java || !existsSync(java)) {
  throw new Error(
    'Set ANDROID_HOME and ANDROID_JAVA_HOME (JDK 21). See docs/android.md.',
  );
}
// Release signing: the keystore path and passwords come only from the
// environment (see docs/android.md). Without them --release is refused, so an
// unsigned file is never mistaken for an installable release.
const signing = [
  'HUB_ANDROID_KEYSTORE',
  'HUB_ANDROID_KEYSTORE_PASSWORD',
  'HUB_ANDROID_KEY_ALIAS',
];
if (release) {
  const missing = signing.filter((name) => !process.env[name]);
  if (missing.length)
    throw new Error(
      `Release builds are signed. Set ${missing.join(', ')}. See docs/android.md.`,
    );
  if (!existsSync(process.env.HUB_ANDROID_KEYSTORE))
    throw new Error('HUB_ANDROID_KEYSTORE does not point to a file.');
}
const git = (...parameters) =>
  execFileSync('git', parameters, { encoding: 'utf8' }).trim();
// versionCode must grow with every release: the commit count on the built
// history does. The name records the exact commit.
const versionCode = Number(git('rev-list', '--count', 'HEAD'));
const dirty = git('status', '--porcelain') !== '';
if (release && dirty)
  throw new Error('Commit or stash changes before a release build.');
const { version: packageVersion } = JSON.parse(
  readFileSync('package.json', 'utf8'),
);
const versionName = `${packageVersion}+${git('rev-parse', '--short=7', 'HEAD')}${dirty ? '.dirty' : ''}`;
const env = {
  ...process.env,
  VITE_HUB_APP_VERSION: `${versionName}${test ? ' (test)' : release ? '' : ' (debug)'}`,
  ANDROID_HOME: sdk,
  JAVA_HOME: java,
  CI: 'true',
  VITE_HUB_API_ORIGIN: server.origin,
  VITE_HUB_ANDROID_TEST: String(test),
};
const run = (command, parameters, cwd = process.cwd()) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, parameters, {
      cwd,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`Build command failed (${code}).`)),
    );
  });
if (!process.env.npm_execpath)
  throw new Error('Run through npm run android:build.');
await run(process.execPath, [
  process.env.npm_execpath,
  'run',
  'build',
  '--workspace',
  '@hub/contracts',
]);
await run(process.execPath, [
  process.env.npm_execpath,
  'run',
  'typecheck',
  '--workspace',
  '@hub/web',
]);
await run(
  process.execPath,
  [
    resolve('node_modules/vite/bin/vite.js'),
    'build',
    '--outDir',
    '../../.artifacts/android-web',
    '--emptyOutDir',
  ],
  resolve('apps/web'),
);
await run(process.execPath, [
  resolve('node_modules/@capacitor/cli/bin/capacitor'),
  'sync',
  'android',
]);
const versionArgs = [
  `-PhubVersionCode=${versionCode}`,
  `-PhubVersionName=${versionName}`,
];
await run(
  process.platform === 'win32' ? 'cmd.exe' : './gradlew',
  process.platform === 'win32'
    ? [
        '/d',
        '/c',
        `.\\gradlew.bat ${release ? 'assembleRelease' : 'assembleDebug'} ${versionArgs.join(' ')} --console=plain`,
      ]
    : [
        release ? 'assembleRelease' : 'assembleDebug',
        ...versionArgs,
        '--console=plain',
      ],
  resolve('apps/android'),
);
const variant = release ? 'release' : 'debug';
mkdirSync('.artifacts/android', { recursive: true });
const output = resolve(
  '.artifacts/android',
  release
    ? `personal-hub-${versionName}.apk`
    : test
      ? 'personal-hub-emulator.apk'
      : 'personal-hub-debug.apk',
);
copyFileSync(
  resolve('apps/android/app/build/outputs/apk', variant, `app-${variant}.apk`),
  output,
);
if (release) {
  const tools = join(sdk, 'build-tools');
  const latest = readdirSync(tools)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  const apksigner = join(
    tools,
    latest,
    process.platform === 'win32' ? 'apksigner.bat' : 'apksigner',
  );
  // Fails the build when the APK is unsigned or the signature is invalid.
  await run(
    process.platform === 'win32' ? 'cmd.exe' : apksigner,
    process.platform === 'win32'
      ? ['/d', '/c', apksigner, 'verify', '--print-certs', output]
      : ['verify', '--print-certs', output],
  );
}
const digest = createHash('sha256').update(readFileSync(output)).digest('hex');
writeFileSync(`${output}.sha256`, `${digest}  ${basename(output)}\n`);
console.log(`APK: ${output}`);
console.log(`Version: ${versionName} (code ${versionCode})`);
console.log(`SHA-256: ${digest}`);
