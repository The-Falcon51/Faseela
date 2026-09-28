package com.faseela.app;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;

/**
 * Faseela Android Application Native Bridge Entrypoint
 */
public class MainActivity extends AppCompatActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // In Capacitor runtime, this delegates to BridgeActivity
    }
}
