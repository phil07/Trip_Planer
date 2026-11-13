package de.phil07.tripplaner;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApkInstallerPlugin.class);
        registerPlugin(AppPermissionsPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Pflicht für das Google-Login-Plugin, damit Scopes (Drive-Zugriff) angefragt werden dürfen.
    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
