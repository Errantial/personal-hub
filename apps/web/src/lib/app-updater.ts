import { Capacitor, registerPlugin } from '@capacitor/core';

/** Mirrors AppUpdaterPlugin.java. */
export type NativeAppInfo = {
  versionName: string;
  versionCode: number;
  packageName: string;
  canInstallPackages: boolean;
};

type InstallAsset = {
  url: string;
  sha256: string;
  size: number;
};

type AppUpdaterPlugin = {
  getInfo(): Promise<NativeAppInfo>;
  openInstallSettings(): Promise<void>;
  install(options: InstallAsset): Promise<{ launched: boolean }>;
};

const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater');

/** The native updater exists only in the Android shell, not the website. */
export const androidUpdaterAvailable = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export async function readNativeAppInfo(): Promise<NativeAppInfo | null> {
  if (!androidUpdaterAvailable()) return null;
  return AppUpdater.getInfo();
}

export async function openNativeInstallSettings() {
  if (!androidUpdaterAvailable())
    throw new Error('Android install settings are unavailable here.');
  await AppUpdater.openInstallSettings();
}

function installErrorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error)
    return String((error as { code?: unknown }).code ?? '');
  return '';
}

/** Capacitor adds the native code to the message as well as the error object. */
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function installNativeUpdate(asset: InstallAsset) {
  if (!androidUpdaterAvailable())
    throw new Error('Install updates from the Personal Hub Android app.');
  if (!/^https:\/\//.test(asset.url))
    throw new Error('The update URL is not HTTPS.');
  if (!/^[a-f0-9]{64}$/.test(asset.sha256))
    throw new Error('The update checksum is invalid.');
  if (!Number.isInteger(asset.size) || asset.size <= 0)
    throw new Error('The update size is invalid.');
  try {
    return await AppUpdater.install(asset);
  } catch (error) {
    const code = installErrorCode(error);
    const detail = `${code} ${errorText(error)}`;
    if (detail.includes('INSTALL_PERMISSION_REQUIRED'))
      throw new Error('Allow installs for Personal Hub, then try again.', {
        cause: error,
      });
    if (detail.includes('DIGEST_MISMATCH'))
      throw new Error(
        'The download did not match its checksum. Nothing was installed.',
        { cause: error },
      );
    if (
      detail.includes('SIZE_MISMATCH') ||
      detail.includes('DOWNLOAD_TOO_LARGE')
    )
      throw new Error(
        'The download size did not match the release. Nothing was installed.',
        { cause: error },
      );
    if (detail.includes('DOWNLOAD_FAILED'))
      throw new Error('The update could not be downloaded. Try again.', {
        cause: error,
      });
    if (detail.includes('DOWNLOAD_URL') || detail.includes('INVALID_URL'))
      throw new Error('The update URL was rejected. Nothing was installed.', {
        cause: error,
      });
    if (detail.includes('ACTIVITY_UNAVAILABLE'))
      throw new Error('Return to Personal Hub and try again.', {
        cause: error,
      });
    if (detail.includes('INSTALL_IN_PROGRESS'))
      throw new Error('An update is already being prepared.', {
        cause: error,
      });
    if (detail.includes('UPDATER_UNAVAILABLE'))
      throw new Error('The updater is unavailable. Reopen Personal Hub.', {
        cause: error,
      });
    if (detail.includes('NO_INSTALLER'))
      throw new Error('Android has no package installer available.', {
        cause: error,
      });
    if (
      detail.includes('INSTALLER_UNAVAILABLE') ||
      detail.includes('FILE_UNAVAILABLE')
    )
      throw new Error(
        'Android could not open the update installer. Nothing was installed.',
        { cause: error },
      );
    throw new Error(
      'The update could not be prepared. Nothing was installed.',
      { cause: error },
    );
  }
}
