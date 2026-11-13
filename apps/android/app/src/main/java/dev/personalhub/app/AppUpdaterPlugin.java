package dev.personalhub.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Native half of the in-app updater. It reports the installed build, opens
 * Android's install-unknown-apps setting for this package, and downloads a
 * manifest-supplied APK with a bounded size and SHA-256 verification before
 * launching Android's package installer. It never installs silently.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final long MAX_DOWNLOAD_BYTES = 250L * 1024 * 1024;
    private static final int MAX_REDIRECTS = 5;
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final Pattern SHA256 = Pattern.compile("^[a-f0-9]{64}$");
    private static final Pattern APK_URL = Pattern.compile(
        "^/Errantial/personal-hub/releases/download/[A-Za-z0-9._+-]+/personal-hub-[A-Za-z0-9._+-]+\\.apk$"
    );

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        // A process death during a download can leave only the partial file;
        // remove it before another attempt. A complete APK is left for the
        // system installer that may still be reading it.
        File directory = new File(getContext().getCacheDir(), "updates");
        File[] files = directory.listFiles();
        if (files != null) {
            for (File file : files) {
                if (file.getName().endsWith(".part")) file.delete();
            }
        }
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageManager manager = getContext().getPackageManager();
            PackageInfo info = manager.getPackageInfo(
                getContext().getPackageName(),
                0
            );
            long versionCode = Build.VERSION.SDK_INT >= 28
                ? info.getLongVersionCode()
                : info.versionCode;
            JSObject result = new JSObject();
            result.put(
                "versionName",
                info.versionName == null ? "" : info.versionName
            );
            result.put("versionCode", versionCode);
            result.put("packageName", getContext().getPackageName());
            result.put("canInstallPackages", canInstallPackages());
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException error) {
            call.reject(
                "App information is unavailable.",
                "INFO_UNAVAILABLE"
            );
        }
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < 26) {
            call.resolve();
            return;
        }
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject(
                "Personal Hub is not in the foreground.",
                "ACTIVITY_UNAVAILABLE"
            );
            return;
        }
        final Intent intent = new Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName())
        );
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(intent);
                call.resolve();
            } catch (ActivityNotFoundException error) {
                call.reject(
                    "Android install settings are unavailable.",
                    "SETTINGS_UNAVAILABLE"
                );
            } catch (Exception error) {
                call.reject(
                    "Android install settings are unavailable.",
                    "SETTINGS_UNAVAILABLE"
                );
            }
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        String location = call.getString("url");
        String digest = call.getString("sha256");
        Object rawSize = call.getData() == null
            ? null
            : call.getData().opt("size");
        if (location == null || digest == null || !(rawSize instanceof Number)) {
            call.reject(
                "The update details are incomplete.",
                "INVALID_ARGUMENT"
            );
            return;
        }
        long size = ((Number) rawSize).longValue();
        if (!SHA256.matcher(digest).matches()) {
            call.reject("The update checksum is invalid.", "INVALID_DIGEST");
            return;
        }
        if (size <= 0 || size > MAX_DOWNLOAD_BYTES) {
            call.reject("The update size is invalid.", "INVALID_SIZE");
            return;
        }
        try {
            if (!isManifestAssetUrl(new URL(location))) {
                call.reject("The update URL was rejected.", "INVALID_URL");
                return;
            }
        } catch (Exception error) {
            call.reject("The update URL was rejected.", "INVALID_URL");
            return;
        }
        if (!canInstallPackages()) {
            call.reject(
                "Allow installs for Personal Hub, then try again.",
                "INSTALL_PERMISSION_REQUIRED"
            );
            return;
        }
        executor.execute(() -> downloadAndLaunch(call, location, size, digest));
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
    }

    private void downloadAndLaunch(
        PluginCall call,
        String location,
        long expectedSize,
        String expectedDigest
    ) {
        File directory = new File(getContext().getCacheDir(), "updates");
        if (!directory.exists() && !directory.mkdirs()) {
            call.reject(
                "The update could not be prepared. Nothing was installed.",
                "DOWNLOAD_FAILED"
            );
            return;
        }
        File target = new File(directory, "personal-hub-update.apk");
        File partial = new File(directory, "personal-hub-update.apk.part");
        // A failed attempt never leaves a file that could be mistaken for an
        // update. The system installer reads only the verified target.
        target.delete();
        partial.delete();
        try {
            download(location, partial, expectedSize, expectedDigest);
            if (!partial.renameTo(target)) {
                throw new UpdateException(
                    "DOWNLOAD_FAILED",
                    "The downloaded update could not be prepared."
                );
            }
            launchInstaller(target, call);
        } catch (UpdateException error) {
            target.delete();
            partial.delete();
            call.reject(error.getMessage(), error.code);
        } catch (Exception error) {
            target.delete();
            partial.delete();
            call.reject(
                "The update could not be downloaded. Nothing was installed.",
                "DOWNLOAD_FAILED"
            );
        }
    }

    private void download(
        String location,
        File target,
        long expectedSize,
        String expectedDigest
    ) throws Exception {
        URL url = new URL(location);
        if (!isManifestAssetUrl(url)) {
            throw new UpdateException(
                "INVALID_URL",
                "The update URL was rejected."
            );
        }
        HttpURLConnection connection = null;
        for (int redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/octet-stream");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setRequestProperty(
                "User-Agent",
                "Personal-Hub-Android-Updater"
            );
            int status = connection.getResponseCode();
            if (
                status == HttpURLConnection.HTTP_MOVED_PERM ||
                status == HttpURLConnection.HTTP_MOVED_TEMP ||
                status == HttpURLConnection.HTTP_SEE_OTHER ||
                status == 307 ||
                status == 308
            ) {
                String next = connection.getHeaderField("Location");
                connection.disconnect();
                connection = null;
                if (next == null) {
                    throw new UpdateException(
                        "DOWNLOAD_FAILED",
                        "The update download was redirected without a target."
                    );
                }
                url = new URL(url, next);
                if (!isRedirectUrl(url)) {
                    throw new UpdateException(
                        "INVALID_URL",
                        "The update download was redirected to an unsafe host."
                    );
                }
                continue;
            }
            if (status != HttpURLConnection.HTTP_OK) {
                connection.disconnect();
                connection = null;
                throw new UpdateException(
                    "DOWNLOAD_FAILED",
                    "The update download was refused."
                );
            }
            break;
        }
        if (connection == null) {
            throw new UpdateException(
                "DOWNLOAD_FAILED",
                "The update download had too many redirects."
            );
        }
        long contentLength = connection.getContentLengthLong();
        if (
            contentLength > MAX_DOWNLOAD_BYTES ||
            (contentLength >= 0 && contentLength != expectedSize)
        ) {
            connection.disconnect();
            throw new UpdateException(
                "SIZE_MISMATCH",
                "The update size did not match the release."
            );
        }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long total = 0;
        try (
            InputStream input = connection.getInputStream();
            FileOutputStream output = new FileOutputStream(target)
        ) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > expectedSize || total > MAX_DOWNLOAD_BYTES) {
                    throw new UpdateException(
                        "DOWNLOAD_TOO_LARGE",
                        "The update exceeded its declared size."
                    );
                }
                output.write(buffer, 0, read);
                digest.update(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
        if (total != expectedSize) {
            throw new UpdateException(
                "SIZE_MISMATCH",
                "The update size did not match the release."
            );
        }
        String actual = hex(digest.digest());
        if (!actual.equals(expectedDigest)) {
            throw new UpdateException(
                "DIGEST_MISMATCH",
                "The update did not match its SHA-256 checksum."
            );
        }
    }

    private void launchInstaller(File apk, PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            apk.delete();
            call.reject(
                "Personal Hub is not in the foreground.",
                "ACTIVITY_UNAVAILABLE"
            );
            return;
        }
        final Uri uri;
        try {
            uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );
        } catch (Exception error) {
            apk.delete();
            call.reject(
                "The downloaded update could not be shared with Android.",
                "FILE_UNAVAILABLE"
            );
            return;
        }
        final Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(
            uri,
            "application/vnd.android.package-archive"
        );
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("Personal Hub update", uri));
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(intent);
                JSObject result = new JSObject();
                result.put("launched", true);
                call.resolve(result);
            } catch (ActivityNotFoundException error) {
                apk.delete();
                call.reject(
                    "Android has no package installer available.",
                    "NO_INSTALLER"
                );
            } catch (Exception error) {
                apk.delete();
                call.reject(
                    "Android could not open the package installer.",
                    "INSTALLER_UNAVAILABLE"
                );
            }
        });
    }

    private boolean canInstallPackages() {
        if (Build.VERSION.SDK_INT < 26) return true;
        try {
            return getContext()
                .getPackageManager()
                .canRequestPackageInstalls();
        } catch (Exception error) {
            return false;
        }
    }

    /** Only this repository's release download path may start a download. */
    private boolean isManifestAssetUrl(URL url) {
        return (
            "https".equals(url.getProtocol()) &&
            url.getUserInfo() == null &&
            url.getPort() == -1 &&
            url.getQuery() == null &&
            url.getRef() == null &&
            "github.com".equals(url.getHost()) &&
            !url.getPath().contains("..") &&
            APK_URL.matcher(url.getPath()).matches()
        );
    }

    /** GitHub redirects release assets to these HTTPS hosts. */
    private boolean isRedirectUrl(URL url) {
        String host = url.getHost();
        return (
            "https".equals(url.getProtocol()) &&
            url.getUserInfo() == null &&
            url.getPort() == -1 &&
            !url.getPath().contains("..") &&
            ("github.com".equals(host) ||
                "objects.githubusercontent.com".equals(host) ||
                "release-assets.githubusercontent.com".equals(host) ||
                "github-releases.githubusercontent.com".equals(host))
        );
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(String.format(Locale.US, "%02x", value & 0xff));
        }
        return result.toString();
    }

    private static final class UpdateException extends Exception {
        private final String code;

        UpdateException(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
