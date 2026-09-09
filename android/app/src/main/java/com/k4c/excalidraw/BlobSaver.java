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

public class BlobSaver {
    private static final String TAG = "BlobSaver";
    private final Context ctx;

    BlobSaver(Context ctx) { this.ctx = ctx; }

    /** called from JS (AndroidBlobSaver.saveFile(name, base64)) */
    @android.webkit.JavascriptInterface
    public void saveFile(String name, String base64, String mime) {
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                ContentResolver cr = ctx.getContentResolver();
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                try (OutputStream os = cr.openOutputStream(uri)) {
                    os.write(data);
                }
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File f = new File(dir, name);
                try (OutputStream os = new FileOutputStream(f)) {
                    os.write(data);
                }
            }
            showToast("Saved to Downloads: " + name);
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
