package com.k4c.excalidraw;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.security.MessageDigest;

public class BlobSaver {
    private static final String TAG = "BlobSaver";
    private static final int MAX_NAME_LENGTH = 120;
    private final Context ctx;
    private final byte[] token;

    BlobSaver(Context ctx, String token) {
        this.ctx = ctx;
        this.token = token.getBytes();
    }

    /** Reduces a page-supplied name to a plain file name inside Downloads. */
    static String safeFileName(String name) {
        String base = name == null ? "" : name;
        base = base.substring(Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\')) + 1);
        base = base.replaceAll("[\\p{Cntrl}:*?\"<>|]", "_").trim();
        while (base.startsWith(".")) base = base.substring(1);
        if (base.length() > MAX_NAME_LENGTH) base = base.substring(base.length() - MAX_NAME_LENGTH);
        return base.isEmpty() ? "excalidraw-export" : base;
    }

    /** called from JS (AndroidBlobSaver.saveFile(token, name, base64, mime)) */
    @android.webkit.JavascriptInterface
    public void saveFile(String callerToken, String name, String base64, String mime) {
        if (callerToken == null || !MessageDigest.isEqual(token, callerToken.getBytes())) {
            Log.w(TAG, "saveFile rejected: invalid bridge token");
            return;
        }
        String fileName = safeFileName(name);
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                ContentResolver cr = ctx.getContentResolver();
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) throw new IllegalStateException("MediaStore insert failed");
                try (OutputStream os = cr.openOutputStream(uri)) {
                    os.write(data);
                }
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File f = new File(dir, fileName);
                try (OutputStream os = new FileOutputStream(f)) {
                    os.write(data);
                }
            }
            showToast("Saved to Downloads: " + fileName);
        } catch (Throwable t) {
            Log.e(TAG, "saveFile failed", t);
            showToast("Save failed: " + t.getMessage());
        }
    }

    private void showToast(final String msg) {
        // JS interface calls run on a background thread
        new android.os.Handler(ctx.getMainLooper()).post(() ->
                Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show());
    }
}
