import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

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
const env = {
  ...process.env,
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
await run(
  process.platform === 'win32' ? 'cmd.exe' : './gradlew',
  process.platform === 'win32'
    ? [
        '/d',
        '/c',
        `.\\gradlew.bat ${release ? 'assembleRelease' : 'assembleDebug'} --console=plain`,
      ]
    : [release ? 'assembleRelease' : 'assembleDebug', '--console=plain'],
  resolve('apps/android'),
);
const variant = release ? 'release' : 'debug';
const apk = `app-${variant}${release ? '-unsigned' : ''}.apk`;
mkdirSync('.artifacts/android', { recursive: true });
const output = resolve(
  '.artifacts/android',
  release
    ? 'personal-hub-unsigned.apk'
    : test
      ? 'personal-hub-emulator.apk'
      : 'personal-hub-debug.apk',
);
copyFileSync(
  resolve('apps/android/app/build/outputs/apk', variant, apk),
  output,
);
console.log(`APK: ${output}`);
