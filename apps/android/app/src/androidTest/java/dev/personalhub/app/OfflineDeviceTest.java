package dev.personalhub.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.os.SystemClock;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Run phases separately against the isolated server, with a process stop between phases. */
@RunWith(AndroidJUnit4.class)
public class OfflineDeviceTest {
    @Rule public ActivityScenarioRule<MainActivity> activity = new ActivityScenarioRule<>(MainActivity.class);

    private String js(String source) throws Exception {
        CompletableFuture<String> result = new CompletableFuture<>();
        activity.getScenario().onActivity(app -> app.getBridge().getWebView().evaluateJavascript(source, result::complete));
        return result.get(10, TimeUnit.SECONDS);
    }

    private void waitFor(String condition) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 45000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if ("true".equals(js("Boolean(" + condition + ")"))) return;
            SystemClock.sleep(250);
        }
        assertTrue("Device UI did not reach the expected state: " + condition, false);
    }

    private void fill(String selector, String value) throws Exception {
        js("(()=>{const e=document.querySelector(" + org.json.JSONObject.quote(selector) + ");Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e," + org.json.JSONObject.quote(value) + ");e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()");
    }

    @Test public void enroll() throws Exception {
        waitFor("document.querySelector('button')");
        assertEquals("true", js("typeof window.Capacitor==='object'"));
        js("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Retry connection')?.click()");
        waitFor("document.querySelector('input[name=email]')");
        fill("input[name=email]", "android@example.test");
        fill("input[name=password]", "synthetic-android-password");
        js("document.querySelector('.auth-panel form').requestSubmit()");
        waitFor("document.querySelector('#tasks-title')");
        waitFor("document.body.textContent.includes('No tasks')");
        assertEquals("true", js("window.isSecureContext && !!navigator.locks"));
        assertEquals("false", js("!!navigator.serviceWorker.controller"));
    }

    @Test public void queueOfflineTask() throws Exception {
        waitFor("document.querySelector('#tasks-title')");
        fill("section[aria-labelledby='tasks-title'] input[name=title]", "Android offline proof");
        fill("section[aria-labelledby='tasks-title'] textarea[name=notes]", "Survives process death");
        js("document.querySelector(\"section[aria-labelledby='tasks-title'] form\").requestSubmit()");
        waitFor("document.querySelector('[aria-label=\"Edit Android offline proof\"]') && !document.querySelector('[aria-label=\"Edit Android offline proof\"]').disabled");
        js("document.querySelector('[aria-label=\"Edit Android offline proof\"]').click()");
        waitFor("document.querySelector(\"section[aria-labelledby='tasks-title'] h3\").textContent.includes('Edit task')");
        fill("section[aria-labelledby='tasks-title'] textarea[name=notes]", "Edited offline, then completed");
        js("document.querySelector(\"section[aria-labelledby='tasks-title'] form\").requestSubmit()");
        waitFor("document.body.textContent.includes('2 pending changes') && !document.querySelector('[aria-label=\"Complete Android offline proof\"]').disabled");
        js("document.querySelector('[aria-label=\"Complete Android offline proof\"]').click()");
        waitFor("document.body.textContent.includes('3 pending changes')");
    }

    @Test public void survivesRestartOffline() throws Exception {
        waitFor("document.querySelector('[aria-label=\"Complete Android offline proof\"]')");
        waitFor("document.body.textContent.includes('3 pending changes')");
        assertEquals("true", js("document.querySelector('[aria-label=\"Complete Android offline proof\"]').checked"));
        assertEquals("true", js("document.body.textContent.includes('Edited offline, then completed')"));
        js("if(document.documentElement.dataset.theme!=='eink')document.querySelector('.theme-button').click()");
        waitFor("document.documentElement.dataset.theme==='eink'");
        assertEquals("true", js("document.documentElement.scrollWidth<=window.innerWidth+1"));
    }

    @Test public void reconnect() throws Exception {
        waitFor("document.querySelector('#tasks-title')");
        js("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Sync now')?.click()");
        waitFor("document.body.textContent.includes('0 pending changes') && !!document.querySelector('[aria-label=\"Complete Android offline proof\"]')");
        assertEquals("1", js("document.querySelectorAll('[aria-label=\"Complete Android offline proof\"]').length"));
        assertEquals("true", js("document.querySelector('[aria-label=\"Complete Android offline proof\"]').checked"));
        assertEquals("\"eink\"", js("document.documentElement.dataset.theme"));
    }
}
