package com.k4c.excalidraw;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

public class MainActivity extends Activity {
    private static final String BASE_URL = "https://steamdeck.example.ts.net:8443";
    private static final String HOST = "steamdeck.example.ts.net";
    private static final String PREFS = "excalidraw";
    private static final String KEY_URL = "url";

    private WebView webView;
    private SharedPreferences prefs;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = prefs.getString(KEY_URL, BASE_URL);

        // handle a VIEW intent (room link tapped elsewhere on the device)
        if (getIntent() != null && getIntent().getDataString() != null) {
            url = getIntent().getDataString();
        }

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                             WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // small "join" button pinned top-right — one tap to enter a room link
        Button join = new Button(this);
        join.setText("⤓ join");
        join.setTextSize(12);
        join.setAllCaps(false);
        join.setAlpha(0.35f);
        FrameLayout.LayoutParams jp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        jp.gravity = Gravity.TOP | Gravity.END;
        jp.topMargin = 12;
        jp.rightMargin = 12;
        root.addView(join, jp);

        setContentView(root);

        join.setOnClickListener(v -> showJoinDialog());

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient());
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        webView.loadUrl(url);
    }

    private void showJoinDialog() {
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(48, 32, 48, 8);
        final EditText input = new EditText(this);
        input.setHint("paste room link (…#room=…)");
        input.setText(prefs.getString(KEY_URL, BASE_URL));
        box.addView(input);
        b.setView(box);
        b.setTitle("Join room");
        b.setPositiveButton("Open", (d, w) -> {
            String u = input.getText().toString().trim();
            if (u.isEmpty()) u = BASE_URL;
            prefs.edit().putString(KEY_URL, u).apply();
            webView.loadUrl(u);
        });
        b.setNeutralButton("New canvas", (d, w) -> {
            prefs.edit().putString(KEY_URL, BASE_URL).apply();
            webView.loadUrl(BASE_URL);
        });
        b.setNegativeButton("Cancel", null);
        b.show();
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
