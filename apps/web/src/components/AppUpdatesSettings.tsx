import { useEffect, useState } from 'react';
import { appUpdateResponseSchema } from '@hub/contracts';
import type { AppUpdateResponse } from '@hub/contracts';
import { requestJson, RequestError } from '../lib/api';
import { formatInstant } from '../lib/format';
import { Help } from './Help';
import {
  androidUpdaterAvailable,
  installNativeUpdate,
  openNativeInstallSettings,
  readNativeAppInfo,
} from '../lib/app-updater';
import type { NativeAppInfo } from '../lib/app-updater';
import {
  formatBytes,
  resolveUpdateDecision,
  updateUnavailableText,
  versionCodeFromBuild,
} from '../lib/app-updates';
import { createNativeInfoLoader } from '../lib/native-info';

/** Set by scripts/android-build.mjs; absent on the website. */
const buildVersionName = import.meta.env.VITE_HUB_APP_VERSION as
  string | undefined;
const buildVersionCode = versionCodeFromBuild(
  import.meta.env.VITE_HUB_APP_VERSION_CODE as string | undefined,
);

const installedVersion = (info: NativeAppInfo | null) =>
  info?.versionName?.trim() || buildVersionName || null;
const installedCode = (info: NativeAppInfo | null) =>
  info?.versionCode ?? buildVersionCode ?? null;

const nativeInfoTimeoutMs = 5000;

export function AppUpdatesSettings() {
  const native = androidUpdaterAvailable();
  const [info, setInfo] = useState<NativeAppInfo | null>(null);
  const [infoState, setInfoState] = useState<
    'checking' | 'ready' | 'unavailable' | 'error'
  >(native ? 'checking' : 'unavailable');
  const [response, setResponse] = useState<AppUpdateResponse | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'install' | 'settings'>('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!native) return;
    const loader = createNativeInfoLoader({
      read: readNativeAppInfo,
      timeoutMs: nativeInfoTimeoutMs,
      onChecking: () => {
        setInfo(null);
        setInfoState('checking');
      },
      onValue: (value) => {
        setInfo(value);
        setInfoState(value ? 'ready' : 'error');
      },
      onError: () => {
        setInfo(null);
        setInfoState('error');
      },
    });
    loader.load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') loader.load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      loader.dispose();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [native]);

  const currentVersion = installedVersion(info);
  const currentCode = installedCode(info);
  const decision = response
    ? resolveUpdateDecision(response, currentCode)
    : null;
  const comparisonCode = currentCode ?? response?.installedVersionCode ?? 0;
  const versionLoading = native && infoState === 'checking';
  const permission = !native
    ? 'Not applicable on the website'
    : info
      ? info.canInstallPackages
        ? 'Allowed'
        : 'Not allowed'
      : infoState === 'error'
        ? 'Unavailable'
        : 'Checking…';

  async function check() {
    if (native && infoState === 'checking') return;
    setBusy('check');
    setError('');
    setStatus('');
    try {
      const value = await requestJson(
        `/api/v1/app/update?platform=android&versionCode=${currentCode ?? 0}`,
        appUpdateResponseSchema,
      );
      setResponse(value);
    } catch (cause) {
      setResponse(null);
      setError(
        cause instanceof RequestError
          ? cause.message
          : 'Connect to check for updates.',
      );
    } finally {
      setBusy('');
    }
  }

  async function allowInstalls() {
    setBusy('settings');
    setError('');
    setStatus('');
    try {
      await openNativeInstallSettings();
      setStatus(
        'Allow installs in Android settings, then return to this page.',
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Android install settings are unavailable.',
      );
    } finally {
      setBusy('');
    }
  }

  async function install() {
    if (!response?.latest?.android) return;
    setBusy('install');
    setError('');
    setStatus('Downloading and verifying the update…');
    try {
      await installNativeUpdate(response.latest.android);
      setStatus('Installer opened. Follow the Android prompt to finish.');
    } catch (cause) {
      setStatus('');
      setError(
        cause instanceof Error
          ? cause.message
          : 'The update could not be prepared. Nothing was installed.',
      );
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="panel preference-panel app-updates">
      <h2>App updates</h2>
      <Help label="App updates">
        Checks the latest stable GitHub release. Android compares the release
        version code; an equal or older code is never offered. Downloads come
        only from this repository over HTTPS, are checked against the release
        SHA-256, and open Android’s installer. Personal Hub never installs
        silently. A different signing key cannot update the installed app. The
        check needs a connection; the rest of Settings keeps working offline.
      </Help>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <dl className="app-update-details">
        <div>
          <dt>Current version</dt>
          <dd>{currentVersion ?? 'Website (no Android app installed)'}</dd>
        </div>
        <div>
          <dt>Version code</dt>
          <dd>{currentCode === null ? 'Not available' : currentCode}</dd>
        </div>
        <div>
          <dt>Last check</dt>
          <dd>
            {response ? formatInstant(response.checkedAt) : 'Not checked yet'}
          </dd>
        </div>
        <div>
          <dt>Install permission</dt>
          <dd>{permission}</dd>
        </div>
      </dl>
      <div className="app-update-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy !== '' || versionLoading}
          onClick={() => void check()}
        >
          {busy === 'check' ? 'Checking…' : 'Check now'}
        </button>
        {native && info && !info.canInstallPackages && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== ''}
            onClick={() => void allowInstalls()}
          >
            {busy === 'settings' ? 'Opening…' : 'Allow installs'}
          </button>
        )}
      </div>

      {response && decision === 'unavailable' && (
        <p role="status">{updateUnavailableText(response.reason)}</p>
      )}
      {response && decision === 'current' && response.latest && (
        <p role="status">
          {response.latest.versionCode < comparisonCode
            ? 'This build is newer than the latest stable release.'
            : 'Up to date.'}{' '}
          Latest release {response.latest.versionName} (code{' '}
          {response.latest.versionCode}).
        </p>
      )}
      {response && decision === 'update-available' && response.latest && (
        <div className="app-update-release">
          <p className="visually-hidden" role="status">
            Update available: version {response.latest.versionName}.
          </p>
          <h3>Version {response.latest.versionName} available</h3>
          <p className="app-update-meta">
            Version code {response.latest.versionCode}
            {response.latest.android
              ? ` · ${formatBytes(response.latest.android.size)}`
              : ''}
          </p>
          {response.latest.notes.trim() && (
            <p
              className="app-update-notes"
              tabIndex={0}
              aria-label="Release notes"
            >
              {response.latest.notes}
            </p>
          )}
          {response.latest.android && native && info?.canInstallPackages && (
            <button
              type="button"
              className="primary-button"
              disabled={busy !== ''}
              onClick={() => void install()}
            >
              {busy === 'install'
                ? 'Downloading and verifying…'
                : 'Download and install'}
            </button>
          )}
          {response.latest.android &&
            native &&
            info &&
            !info.canInstallPackages && (
              <p>Allow installs before downloading this update.</p>
            )}
          {response.latest.android && !native && (
            <p>
              Open Personal Hub on Android to download and install this update.
            </p>
          )}
          {response.latest.android && native && infoState === 'error' && (
            <p>App information is unavailable. Reopen Personal Hub.</p>
          )}
        </div>
      )}
      <p className="app-update-desktop">
        Desktop:{' '}
        {response?.latest && response.latest.desktop.length > 0
          ? response.latest.desktop.map((asset) => asset.platform).join(', ')
          : 'no build is published for this release.'}
      </p>
    </section>
  );
}
