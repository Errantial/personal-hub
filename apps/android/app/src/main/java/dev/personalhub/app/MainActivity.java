package dev.personalhub.app;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /** A healthy cold start shows the page in about 2 s on the Kompakt. */
    private static final long BLANK_TIMEOUT_MS = 8000;
    /** A second blank launch inside this window stops automatic recovery. */
    private static final long RECOVERY_WINDOW_MS = 120000;
    private static final String PREFS = "hub-shell";
    private static final String LAST_RECOVERY = "blank-recovery-at";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable blankCheck = this::checkBlank;
    private boolean pageVisible;
    private boolean resumed;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Capacitor discovers custom plugins before the bridge is created.
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        // Capacitor's stock activity leaves desktop-style history navigation
        // to the WebView. Route the system Back gesture through WebView history
        // and only leave the app when there is nowhere left to go.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() != null && getBridge().getWebView().canGoBack()) {
                    getBridge().getWebView().goBack();
                } else {
                    // Do not delegate to the stock callback: it can swallow the
                    // gesture without leaving the app. Keep this callback
                    // enabled so later Back presses still background the task.
                    moveTaskToBack(true);
                }
            }
        });
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    pageVisible = true;
                    handler.removeCallbacks(blankCheck);
                }
            });
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
        if (!pageVisible) {
            handler.removeCallbacks(blankCheck);
            handler.postDelayed(blankCheck, BLANK_TIMEOUT_MS);
        }
    }

    @Override
    public void onPause() {
        resumed = false;
        handler.removeCallbacks(blankCheck);
        super.onPause();
    }

    /*
     * MuditaOS K 1.6.1 (WebView 149): if the process dies while the app is in
     * the foreground, the next launch never gets a WebView renderer and stays
     * blank. A process that dies while backgrounded launches cleanly next
     * time. So when the page never appears, leave the foreground and exit;
     * the owner reopens the app. See docs/android.md.
     */
    private void checkBlank() {
        if (pageVisible || !resumed || isFinishing()) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        long now = SystemClock.elapsedRealtime();
        // -1 means never. elapsedRealtime restarts at boot, so a stored value
        // larger than now is from before a reboot and counts as no recent attempt.
        long last = prefs.getLong(LAST_RECOVERY, -1);
        if (last >= 0 && last <= now && now - last < RECOVERY_WINDOW_MS) {
            Toast.makeText(this, R.string.blank_recovery_failed, Toast.LENGTH_LONG).show();
            return;
        }
        prefs.edit().putLong(LAST_RECOVERY, now).commit();
        Toast.makeText(this, R.string.blank_recovery, Toast.LENGTH_LONG).show();
        moveTaskToBack(true);
        handler.postDelayed(() -> {
            finishAndRemoveTask();
            android.os.Process.killProcess(android.os.Process.myPid());
        }, 1500);
    }
}
