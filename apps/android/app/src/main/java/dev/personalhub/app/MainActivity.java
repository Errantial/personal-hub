package dev.personalhub.app;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
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
                    // gesture without leaving the app.
                    setEnabled(false);
                    moveTaskToBack(true);
                }
            }
        });
    }
}
