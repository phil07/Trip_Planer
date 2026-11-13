package de.phil07.tripplaner;

import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// Lädt die APK-Datei eines Updates direkt in der App (nicht über die WebView), speichert sie im Cache
// und öffnet den Android-Installationsdialog. Installieren bestätigt der Nutzer dort selbst.
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("Ungültige Update-Adresse");
            return;
        }
        new Thread(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                int code = conn.getResponseCode();
                if (code / 100 != 2) {
                    call.reject("Download: HTTP " + code);
                    return;
                }
                File dir = new File(getContext().getCacheDir(), "update");
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("Ordner für das Update konnte nicht angelegt werden");
                    return;
                }
                File apk = new File(dir, "app-update.apk");
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                call.reject("Download fehlgeschlagen: " + e.getMessage());
            }
        }).start();
    }
}
