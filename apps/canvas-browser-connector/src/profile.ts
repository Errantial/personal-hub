import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const markerName = '.personal-hub-canvas-browser-profile';
const markerBody = 'personal-hub canvas browser profile v1\n';

export async function ensureDedicatedProfile(path: string) {
  await mkdir(path, { recursive: true });
  const marker = join(path, markerName);
  try {
    const value = await readFile(marker, 'utf8');
    if (value !== markerBody)
      throw new Error('Canvas browser profile marker is invalid.');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const entries = await readdir(path);
  if (entries.length)
    throw new Error(
      'Canvas browser profilePath must be a new/empty dedicated directory or an existing Personal Hub marked profile.',
    );
  await writeFile(marker, markerBody, { encoding: 'utf8', flag: 'wx' });
}
