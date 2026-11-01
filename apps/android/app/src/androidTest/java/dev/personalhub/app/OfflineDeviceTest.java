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

    private void clickText(String selector, String text) throws Exception {
        js("Array.from(document.querySelectorAll(" + org.json.JSONObject.quote(selector) + ")).find(e=>e.textContent.trim()===" + org.json.JSONObject.quote(text) + ")?.click()");
    }

    /** Open Tasks, then the completed task's editor, whether or not the route survived restart. */
    private void openOfflineTask() throws Exception {
        waitFor("document.querySelector('.nav')");
        js("if (!document.querySelector('#task-list-title') && !document.querySelector('#task-editor-title')) { const t=Array.from(document.querySelectorAll('nav a')).find(e=>e.textContent.trim().startsWith('Tasks')); if(t)t.click(); }");
        waitFor("document.querySelector('#task-list-title') || document.querySelector('#task-editor-title')");
        if ("false".equals(js("Boolean(document.querySelector('#task-editor-title'))"))) {
            js("const d=Array.from(document.querySelectorAll('nav[aria-label=\"Task filters\"] a')).find(e=>e.textContent.trim().startsWith('Done'));if(d)d.click()");
            waitFor("Array.from(document.querySelectorAll('a.task-row__title')).some(e=>e.textContent.trim()==='Android offline proof')");
            clickText("a.task-row__title", "Android offline proof");
        }
        waitFor("document.querySelector('#task-editor-title')");
    }

    private void enableEink() throws Exception {
        if ("true".equals(js("document.documentElement.dataset.theme==='eink'"))) return;
        if ("false".equals(js("Boolean(Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('E-ink mode') && e.offsetParent!==null))"))) {
            js("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim().startsWith('More'))?.click()");
        }
        waitFor("Array.from(document.querySelectorAll('button')).some(e=>e.textContent.includes('E-ink mode') && e.offsetParent!==null)");
        js("Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('E-ink mode') && e.offsetParent!==null)?.click()");
        waitFor("document.documentElement.dataset.theme==='eink'");
    }

    @Test public void enroll() throws Exception {
        waitFor("document.querySelector('button')");
        assertEquals("true", js("typeof window.Capacitor==='object'"));
        js("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Retry connection')?.click()");
        waitFor("document.querySelector('input[name=email]')");
        fill("input[name=email]", "android@example.test");
        fill("input[name=password]", "synthetic-android-password");
        js("document.querySelector('.auth-panel form').requestSubmit()");
        waitFor("document.querySelector('.nav')");
        clickText("nav a", "Tasks");
        waitFor("document.querySelector('#task-list-title')");
        waitFor("document.body.textContent.includes('No open tasks')");
        assertEquals("true", js("window.isSecureContext && !!navigator.locks"));
        assertEquals("false", js("!!navigator.serviceWorker.controller"));
    }

    @Test public void queueOfflineTask() throws Exception {
        waitFor("document.querySelector('.nav')");
        clickText("nav a", "Tasks");
        waitFor("document.querySelector('#task-list-title')");
        js("Array.from(document.querySelectorAll('.quick-capture button')).find(e=>e.textContent==='Add task')?.click()");
        waitFor("document.querySelector('.quick-capture input[name=title]')");
        fill(".quick-capture input[name=title]", "Android offline proof");
        js("document.querySelector('.quick-capture form').requestSubmit()");
        waitFor("Array.from(document.querySelectorAll('a.task-row__title')).some(e=>e.textContent.trim()==='Android offline proof')");
        clickText("a.task-row__title", "Android offline proof");
        waitFor("document.querySelector('#task-editor-title')");
        fill("section[aria-labelledby='task-editor-title'] textarea[name=notes]", "Edited offline, then completed");
        js("document.querySelector(\"section[aria-labelledby='task-editor-title'] form\").requestSubmit()");
        waitFor("document.body.textContent.includes('2 queued')");
        waitFor("!document.querySelector(\"section[aria-labelledby='task-editor-title'] .primary-button\").disabled");
        // The open editor owns the task; the hidden list checkbox must be disabled.
        assertEquals("true", js("document.querySelector('input[aria-label=\"Complete Android offline proof\"]').disabled"));
        js("document.querySelector(\"section[aria-labelledby='task-editor-title'] input[type=checkbox]\").click()");
        waitFor("document.querySelector(\"section[aria-labelledby='task-editor-title'] input[type=checkbox]\").checked");
        js("document.querySelector(\"section[aria-labelledby='task-editor-title'] form\").requestSubmit()");
        waitFor("document.body.textContent.includes('3 queued')");
    }

    @Test public void survivesRestartOffline() throws Exception {
        openOfflineTask();
        waitFor("document.body.textContent.includes('3 queued')");
        assertEquals("true", js("document.querySelector(\"section[aria-labelledby='task-editor-title'] input[type=checkbox]\").checked"));
        assertEquals("true", js("document.body.textContent.includes('Edited offline, then completed')"));
        enableEink();
        assertEquals("true", js("document.documentElement.scrollWidth<=window.innerWidth+1"));
    }

    @Test public void reconnect() throws Exception {
        openOfflineTask();
        js("Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Sync now')?.click()");
        waitFor("document.body.textContent.includes('All saved')");
        assertEquals("true", js("document.querySelector(\"section[aria-labelledby='task-editor-title'] input[type=checkbox]\").checked"));
        assertEquals("true", js("document.body.textContent.includes('Edited offline, then completed')"));
        assertEquals("\"eink\"", js("document.documentElement.dataset.theme"));
    }
}
