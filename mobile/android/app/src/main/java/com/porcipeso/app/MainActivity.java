package com.porcipeso.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugin local (no-npm): registrarlo ANTES de super.onCreate().
        registerPlugin(PorciSerialPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
