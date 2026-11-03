package app.polygons.otg;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.OutputStream;

/**
 * Hosts the Polygons OTG web app in a full-screen WebView.
 * Assets are served from https://appassets.androidplatform.net/assets/web/
 * so ES modules, IndexedDB autosave and WebGL work like on the web.
 * A small JS bridge saves exported files through the Storage Access Framework.
 */
public class MainActivity extends Activity {
    private static final int REQ_SAVE = 41;
    private static final int REQ_OPEN = 42;
    private static final String START_URL = "https://appassets.androidplatform.net/assets/web/index.html";

    private WebView web;
    private ValueCallback<Uri[]> pendingChooser;
    private byte[] pendingSave;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);
        goImmersive();

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setBackgroundColor(0xFF1B1C20);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingChooser != null) pendingChooser.onReceiveValue(null);
                pendingChooser = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                // Model formats have no reliable MIME type on Android: allow any file,
                // but keep image filtering for texture pickers.
                boolean images = types != null && types.length > 0 && types[0].startsWith("image/");
                i.setType(images ? "image/*" : "*/*");
                try {
                    startActivityForResult(i, REQ_OPEN);
                } catch (Exception e) {
                    pendingChooser = null;
                    return false;
                }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "PolygonsAndroid");
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    private void goImmersive() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        // Let the app close menus / cancel tools / leave sub-modes first.
        web.evaluateJavascript("(window.__onAndroidBack && window.__onAndroidBack()) ? 'handled' : 'exit'", value -> {
            if (value != null && value.contains("handled")) return;
            MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_OPEN) {
            if (pendingChooser != null) {
                Uri[] res = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) res = new Uri[]{data.getData()};
                pendingChooser.onReceiveValue(res);
                pendingChooser = null;
            }
        } else if (requestCode == REQ_SAVE) {
            boolean ok = false;
            String msg = "Save cancelled";
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingSave != null) {
                try (OutputStream os = getContentResolver().openOutputStream(data.getData(), "wt")) {
                    if (os != null) {
                        os.write(pendingSave);
                        ok = true;
                        msg = "Saved";
                    }
                } catch (Exception e) {
                    msg = "Save failed: " + e.getMessage();
                }
            }
            pendingSave = null;
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
            final String js = "window.__polygonsSaveResult && window.__polygonsSaveResult(" + ok + "," + jsString(msg) + ")";
            web.evaluateJavascript(js, null);
        }
    }

    private static String jsString(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }

    /** Methods callable from JavaScript as window.PolygonsAndroid.*. */
    private class Bridge {
        @JavascriptInterface
        public boolean isAndroid() { return true; }

        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String base64) {
            final byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> {
                pendingSave = bytes;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(i, REQ_SAVE);
                } catch (Exception e) {
                    pendingSave = null;
                    Toast.makeText(MainActivity.this, "No file picker available", Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
