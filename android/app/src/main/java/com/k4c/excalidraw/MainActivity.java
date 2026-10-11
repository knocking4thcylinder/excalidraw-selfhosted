package com.k4c.excalidraw;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.security.SecureRandom;

public class MainActivity extends Activity {
    private static final String APP_SCHEME = "https";
    private static final String APP_HOST = "@APP_HOST@"; // filled in by build.sh
    private static final int APP_PORT = 8443;
    private static final String BASE_URL = APP_SCHEME + "://" + APP_HOST + ":" + APP_PORT;

    private WebView webView;

    /** Exact origin match: prefix checks accept hosts like "<APP_HOST>:8443.evil.com". */
    static boolean isAppUrl(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        return APP_SCHEME.equals(uri.getScheme())
                && APP_HOST.equalsIgnoreCase(uri.getHost())
                && uri.getPort() == APP_PORT
                && uri.getUserInfo() == null;
    }

    private static String appUrlFrom(Intent intent) {
        String url = intent != null ? intent.getDataString() : null;
        return isAppUrl(url) ? url : null;
    }

    private static String newBridgeToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder token = new StringBuilder();
        for (byte b : bytes) token.append(String.format("%02x", b));
        return token.toString();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                             WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);

        // blob-file exports (PNG/SVG/.excalidraw) land in Downloads via our bridge.
        // addJavascriptInterface is visible to every frame (including embeddable
        // iframes), so saveFile requires a per-launch token that is only handed to
        // the app's top-level document by evaluateJavascript below.
        final String bridgeToken = newBridgeToken();
        webView.addJavascriptInterface(new BlobSaver(MainActivity.this, bridgeToken), "AndroidBlobSaver");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(android.webkit.WebView view, String u) {
                if (isAppUrl(u)) {
                    view.evaluateJavascript(
                        "(function(token){" +
                        "  if (window.__blobHookInstalled) return;" +
                        "  window.__blobHookInstalled=true;" +
                        "  const proto=HTMLAnchorElement.prototype;" +
                        "  const orig=proto.click;" +
                        "  proto.click=function(){" +
                        "    if(this.download && this.href && this.href.startsWith('blob:')){" +
                        "      const anchor=this;" +
                        "      fetch(anchor.href).then(r=>r.blob()).then(b=>{" +
                        "        const fr=new FileReader();" +
                        "        fr.onload=()=>{var p=fr.result.split(',');window.AndroidBlobSaver.saveFile(token, anchor.download, p[1], b.type||'application/octet-stream');};" +
                        "        fr.readAsDataURL(b);" +
                        "      });" +
                        "      return;" +
                        "    }" +
                        "    orig.call(this);" +
                        "  };" +
                        "})('" + bridgeToken + "')", null);
                }
                super.onPageFinished(view, u);
            }

            @Override
            public boolean shouldOverrideUrlLoading(android.webkit.WebView v, String u) {
                // keep same-origin links (room links, opens-in-app URLs) in the app
                return !isAppUrl(u);
            }
        });
        webView.setWebChromeClient(new WebChromeClient());

        // no onCreateWindow override: the blob-hook on anchor.click covers Excalidraw exports,
        // and d8 chokes on the WebViewTransport nested class in this anonymous client.

        // network-based exports (non-blob) → DownloadManager
        webView.setDownloadListener((u2, userAgent, contentDisposition, mimeType, contentLength) -> {
                if (!isAppUrl(u2)) return;
                String fileName = BlobSaver.safeFileName(
                        URLUtil.guessFileName(u2, contentDisposition, mimeType));
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(u2));
                req.setMimeType(mimeType);
                String cookies = CookieManager.getInstance().getCookie(u2);
                if (cookies != null) req.addRequestHeader("cookie", cookies);
                req.addRequestHeader("User-Agent", userAgent);
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setTitle(fileName);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                dm.enqueue(req);
                Toast.makeText(MainActivity.this, "Saving " + fileName, Toast.LENGTH_SHORT).show();
        });

        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        String intentUrl = appUrlFrom(getIntent());
        if (intentUrl == null && savedInstanceState != null
                && webView.restoreState(savedInstanceState) != null) {
            return;
        }
        webView.loadUrl(intentUrl != null ? intentUrl : BASE_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String url = appUrlFrom(intent);
        if (url != null) {
            webView.loadUrl(url);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
