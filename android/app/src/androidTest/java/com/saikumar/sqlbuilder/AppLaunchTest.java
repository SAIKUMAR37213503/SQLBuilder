package com.saikumar.sqlbuilder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * On-device checks for the packaged app. The web UI itself is exercised by
 * scripts/android-e2e.mjs (CI) through the WebView debugging protocol.
 */
@RunWith(AndroidJUnit4.class)
public class AppLaunchTest {

    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test
    public void usesTheReleasePackageName() {
        assertEquals("com.saikumar.sqlbuilder", context.getPackageName());
    }

    @Test
    public void requestsNoUserFacingPermissions() throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
        if (info.requestedPermissions == null) return;
        for (String permission : info.requestedPermissions) {
            // AndroidX adds an app-private signature permission for its own receivers; nothing else is allowed
            assertTrue("Unexpected permission: " + permission, permission.startsWith(context.getPackageName() + "."));
        }
    }

    @Test
    public void launchesAndServesThePackagedWebContent() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<String> url = new AtomicReference<>("");
            long deadline = System.currentTimeMillis() + 20000;
            while (System.currentTimeMillis() < deadline) {
                scenario.onActivity(activity -> {
                    String current = activity.getBridge().getWebView().getUrl();
                    url.set(current == null ? "" : current);
                });
                if (!url.get().isEmpty()) break;
                Thread.sleep(250);
            }
            // Capacitor serves the bundled www/ folder from https://localhost — never a remote site
            assertTrue("Unexpected start URL: " + url.get(), url.get().startsWith("https://localhost"));
            assertFalse(url.get().contains("vercel.app"));
        }
    }
}
