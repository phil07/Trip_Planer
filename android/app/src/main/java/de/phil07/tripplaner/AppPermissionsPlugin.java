package de.phil07.tripplaner;

import android.Manifest;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

// Fragt beim Start die Android-Berechtigungen an, die die App braucht: Standort und Benachrichtigungen.
// Der Nutzer entscheidet im System-Dialog; abgelehnte Rechte kann man später in den Einstellungen ändern.
@CapacitorPlugin(name = "AppPermissions", permissions = {
    @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, alias = "location"),
    @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
})
public class AppPermissionsPlugin extends Plugin {

    @PluginMethod
    public void request(PluginCall call) {
        requestPermissionForAliases(new String[] { "location", "notifications" }, call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        JSObject result = new JSObject();
        result.put("location", getPermissionState("location").toString());
        result.put("notifications", getPermissionState("notifications").toString());
        call.resolve(result);
    }
}
