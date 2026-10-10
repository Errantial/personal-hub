import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function check(label, ready, detail, required = true) {
  console.log(
    `${ready ? 'OK' : required ? 'MISSING' : 'OPTIONAL'} ${label}: ${detail}`,
  );
  if (!ready && required) process.exitCode = 1;
}
check(
  'Node',
  Number(process.versions.node.split('.')[0]) === 24,
  process.versions.node,
);
const npmVersion =
  process.env.npm_config_user_agent?.match(/npm\/([\d.]+)/)?.[1];
check(
  'npm',
  Number(npmVersion?.split('.')[0]) >= 11,
  npmVersion ?? 'run this with npm run doctor',
);
check(
  'Git',
  spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
    .status === 0,
  'local version control',
);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packages = { ...manifest.devDependencies };
let installed = true;
for (const [name, version] of Object.entries(packages)) {
  try {
    installed &&=
      JSON.parse(
        readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'),
      ).version === version;
  } catch {
    installed = false;
  }
}
check(
  'Dependencies',
  installed,
  installed
    ? 'root tooling matches manifest; npm ci verifies all workspaces'
    : 'run npm ci',
);
check(
  'Configuration',
  existsSync(join(root, '.env.example')),
  'local defaults require no credentials',
);
const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
check(
  'Android SDK',
  Boolean(sdkRoot && existsSync(join(sdkRoot, 'cmdline-tools'))),
  'required later for APK/device verification',
  false,
);
console.log('Next: npm run dev; create the owner at http://127.0.0.1:5173.');
