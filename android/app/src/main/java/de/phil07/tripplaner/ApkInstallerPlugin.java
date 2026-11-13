package de.phil07.tripplaner;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;

// Speichert eine heruntergeladene APK im Cache der App und öffnet den Android-Installationsdialog.
// Die Installation bestätigt der Nutzer im System-Dialog; die App kann nicht still installieren.
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void saveAndInstall(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("Keine APK-Daten");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "update");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("Ordner für das Update konnte nicht angelegt werden");
                return;
            }
            File apk = new File(dir, "app-update.apk");
            try (FileOutputStream out = new FileOutputStream(apk)) {
                out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Installation nicht möglich: " + e.getMessage());
        }
    }
}
