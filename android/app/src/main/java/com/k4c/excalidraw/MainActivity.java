package com.k4c.excalidraw;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.SharedPreferences;
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

public class MainActivity extends Activity {
    private static final String BASE_URL = "https://steamdeck.example.ts.net:8443";
    private static final String PREFS = "excalidraw";
    private static final String KEY_URL = "url";

    private WebView webView;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = prefs.getString(KEY_URL, BASE_URL);

        if (getIntent() != null && getIntent().getDataString() != null) {
            url = getIntent().getDataString();
        }

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

        // file exports (PNG / SVG / .excalidraw) → device Downloads via MediaStore
        // blob-file exports (PNG/SVG/.excalidraw) land in Downloads via our bridge
        webView.addJavascriptInterface(new BlobSaver(MainActivity.this), "AndroidBlobSaver");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(android.webkit.WebView view, String u) {
                view.evaluateJavascript(
                    "(function(){" +
                    "  if (window.__blobHookInstalled) return;" +
                    "  window.__blobHookInstalled=true;" +
                    "  const proto=HTMLAnchorElement.prototype;" +
                    "  const orig=proto.click;" +
                    "  proto.click=function(){" +
                    "    if(this.download && this.href && this.href.startsWith('blob:')){" +
                    "      const anchor=this;" +
                    "      fetch(anchor.href).then(r=>r.blob()).then(b=>{" +
                    "        const fr=new FileReader();" +
                    "        fr.onload=()=>{var p=fr.result.split(',');window.AndroidBlobSaver.saveFile(anchor.download, p[1], b.type||'application/octet-stream');};" +
                    "        fr.readAsDataURL(b);" +
                    "      });" +
                    "      return;" +
                    "    }" +
                    "    orig.call(this);" +
                    "  };" +
                    "})()", null);
                super.onPageFinished(view, u);
            }

            @Override
            public boolean shouldOverrideUrlLoading(android.webkit.WebView v, String u) {
                // keep same-origin links (room links, opens-in-app URLs) in the app
                return !u.startsWith(BASE_URL);
            }
        });
        webView.setWebChromeClient(new WebChromeClient());

        // no onCreateWindow override: the blob-hook on anchor.click covers Excalidraw exports,
        // and d8 chokes on the WebViewTransport nested class in this anonymous client.

        // network-based exports (non-blob) → DownloadManager
        webView.setDownloadListener((u2, userAgent, contentDisposition, mimeType, contentLength) -> {
                String fileName = URLUtil.guessFileName(u2, contentDisposition, mimeType);
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
                android.widget.Toast.makeText(MainActivity.this, "Saving " + fileName, android.widget.Toast.LENGTH_SHORT).show();
        });

        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        webView.loadUrl(url);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getDataString() != null) {
            webView.loadUrl(intent.getDataString());
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
