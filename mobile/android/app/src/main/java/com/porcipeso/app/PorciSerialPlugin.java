package com.porcipeso.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.location.LocationManager;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;
import com.hoho.android.usbserial.util.SerialInputOutputManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Plugin local de PorciPeso: conectividad serial nativa que a los plugins
 * de npm les falta.
 *
 *  - Bluetooth clásico: lista de EMPAREJADOS (getBondedDevices) y un canal
 *    SPP CRUDO cuyo read() entrega los bytes en base64, SIN decodificar como
 *    texto. (@e-is/capacitor-bluetooth-serial hace new String(bytes) UTF-8 y
 *    convierte en U+FFFD los bytes >= 0x80 — exactamente los que produce una
 *    señal TTL invertida, el caso HC-05/BC04 soldado al indicador.)
 *  - USB/OTG: enumeración y puerto serial vía usb-serial-for-android
 *    (mik3y, JitPack) — CDC-ACM, FTDI, CH340/CH341, CP210x, PL2303.
 *
 * Contrato TS: mobile/src/serial.ts (PorciSerialPlugin).
 */
@CapacitorPlugin(
    name = "PorciSerial",
    permissions = {
        @Permission(
            alias = PorciSerialPlugin.BT_ALIAS,
            strings = {
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            }
        ),
        @Permission(
            alias = PorciSerialPlugin.LOCATION_ALIAS,
            strings = { Manifest.permission.ACCESS_FINE_LOCATION }
        )
    }
)
public class PorciSerialPlugin extends Plugin {

    static final String BT_ALIAS = "bluetooth";
    static final String LOCATION_ALIAS = "location";
    private static final String TAG = "PorciSerial";
    private static final UUID SPP_UUID =
        UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final String ACTION_USB_PERMISSION = "com.porcipeso.app.USB_PERMISSION";
    private static final int MAX_BUFFER = 64 * 1024;
    /**
     * Espera máxima al emparejado (Android muestra su diálogo de PIN mientras).
     * BAJA a propósito (~12 s, no 25): un módulo "RS232/485" que en realidad es
     * BLE (o dual-mode cuyo SPP no sirve) NUNCA completa el bond clásico, así que
     * cuanto antes venza este latch, antes cae el flujo al FALLBACK BLE por MAC
     * del apishim. Un módulo NO bondable ni siquiera llega aquí: createBond()
     * devuelve false y rechazamos de inmediato (no bloquea).
     */
    private static final long BOND_TIMEOUT_MS = 12_000L;

    private final ExecutorService executor = Executors.newCachedThreadPool();

    // ------------------------------------------------------------ estado BT
    private final Object btLock = new Object();
    private BluetoothSocket btSocket;
    private Thread btReaderThread;
    private final ByteArrayOutputStream btBuffer = new ByteArrayOutputStream();
    private volatile boolean btRunning = false;
    // Enlace REALMENTE vivo (socket abierto + hilo lector corriendo). Se cae a
    // false en cuanto el hilo lector muere por IOException/EOF (módulo
    // reiniciado, fuera de rango, ruido) para que btRead/btStatus reporten el
    // estado honesto y el driver TS dispare la reconexión sin depender de una
    // excepción del puente. Distinto de btRunning: btRunning es la INTENCIÓN
    // (queremos leer), btConnected es el HECHO (el socket entrega bytes).
    private volatile boolean btConnected = false;

    // ------------------------------------------------- estado discovery BT
    private final Object discLock = new Object();
    private final LinkedHashMap<String, JSObject> discFound = new LinkedHashMap<>();
    private boolean discFinished = true;
    private BroadcastReceiver discReceiver;

    // ----------------------------------------------------------- estado USB
    private final Object usbLock = new Object();
    private UsbSerialPort usbPort;
    private SerialInputOutputManager usbIoManager;
    private final ByteArrayOutputStream usbBuffer = new ByteArrayOutputStream();
    private PluginCall pendingUsbCall;
    private BroadcastReceiver usbPermissionReceiver;

    // ================================================================== BT

    private BluetoothAdapter getAdapter() {
        BluetoothManager manager =
            (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return manager != null ? manager.getAdapter() : null;
    }

    /** En Android 12+ getBondedDevices()/connect exigen BLUETOOTH_CONNECT runtime. */
    private boolean needsBtPermission() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && getPermissionState(BT_ALIAS) != PermissionState.GRANTED;
    }

    @PluginMethod
    public void listPaired(PluginCall call) {
        if (needsBtPermission()) {
            requestPermissionForAlias(BT_ALIAS, call, "btPermissionCallback");
            return;
        }
        resolveListPaired(call);
    }

    @PluginMethod
    public void btConnect(PluginCall call) {
        if (needsBtPermission()) {
            requestPermissionForAlias(BT_ALIAS, call, "btPermissionCallback");
            return;
        }
        doBtConnect(call);
    }

    @PermissionCallback
    private void btPermissionCallback(PluginCall call) {
        if (getPermissionState(BT_ALIAS) != PermissionState.GRANTED) {
            call.reject("permission_denied: Bluetooth (dispositivos cercanos)");
            return;
        }
        if ("btConnect".equals(call.getMethodName())) {
            doBtConnect(call);
        } else {
            resolveListPaired(call);
        }
    }

    @SuppressLint("MissingPermission")
    private void resolveListPaired(PluginCall call) {
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null) {
            call.reject("no_device: este equipo no tiene Bluetooth");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("bluetooth_off");
            return;
        }
        try {
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            JSArray devices = new JSArray();
            if (bonded != null) {
                for (BluetoothDevice device : bonded) {
                    JSObject o = new JSObject();
                    String name = device.getName();
                    o.put("name", name != null ? name : "");
                    o.put("address", device.getAddress());
                    devices.put(o);
                }
            }
            JSObject ret = new JSObject();
            ret.put("devices", devices);
            call.resolve(ret);
        } catch (SecurityException e) {
            call.reject("permission_denied: " + e.getMessage());
        }
    }

    @SuppressLint("MissingPermission")
    private void doBtConnect(PluginCall call) {
        String address = call.getString("address");
        if (address == null || address.isEmpty()) {
            call.reject("falta 'address' (MAC Bluetooth)");
            return;
        }
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("bluetooth_off");
            return;
        }
        executor.execute(() -> {
            try {
                closeBtLocked();
                BluetoothDevice device = adapter.getRemoteDevice(address);
                // AUTO-EMPAREJADO: en Android un SPP a un dispositivo NO BONDED
                // falla justo con "read ret: -1". Aseguramos el bond ANTES del
                // connectSpp (Android muestra su diálogo de PIN si hace falta).
                ensureBonded(adapter, device);
                BluetoothSocket socket = connectSpp(adapter, device);
                InputStream in = socket.getInputStream();
                synchronized (btLock) {
                    btSocket = socket;
                    btBuffer.reset();
                    btRunning = true;
                    btConnected = true;
                    btReaderThread = new Thread(() -> btReadLoop(socket, in), "porciserial-bt");
                    btReaderThread.start();
                }
                call.resolve();
            } catch (PairException e) {
                // mensaje en humano tal cual ("no_pair: …"); el shim TS lo reconoce
                call.reject(e.getMessage());
            } catch (SecurityException e) {
                call.reject("permission_denied: " + e.getMessage());
            } catch (IOException e) {
                call.reject("No pude conectar al Bluetooth " + address + ": " + e.getMessage());
            }
        });
    }

    /** Emparejado fallido/cancelado: rechazo claro y accionable (distinto del
     *  fallo de SPP para que el shim/ UI ofrezca "Emparejar e intentar de nuevo").
     *  Extiende IOException pero se captura ANTES que ella en doBtConnect. */
    private static final class PairException extends IOException {
        PairException(String message) {
            super(message);
        }
    }

    private static final String NO_PAIR_MSG =
        "no_pair: no se pudo emparejar el módulo — acepta el emparejamiento en "
            + "Android (PIN 1234) y reintenta";

    /**
     * Asegura que el dispositivo esté EMPAREJADO (BONDED) antes del SPP.
     *
     * En Android, createRfcommSocket().connect() a un dispositivo NO bonded
     * falla con "read failed, socket might closed or timeout, read ret: -1"
     * (el síntoma exacto de campo del módulo RS232/485). La solución es forzar
     * el bond primero: device.createBond() dispara el diálogo de PIN del
     * sistema (para HC-05/BC04 el PIN es 1234/0000; NO podemos autollenarlo sin
     * ser app de sistema, así que dejamos que Android lo pida) y esperamos el
     * resultado por un BroadcastReceiver de ACTION_BOND_STATE_CHANGED hasta
     * BOND_BONDED o BOND_NONE, con timeout.
     *
     * cancelDiscovery() SIEMPRE antes del bond: un discovery en curso interfiere
     * con el emparejado igual que con el connect. El receiver se desregistra al
     * terminar. Verifica el permiso BLUETOOTH_CONNECT (Android 12+).
     */
    @SuppressLint("MissingPermission")
    private void ensureBonded(BluetoothAdapter adapter, BluetoothDevice device)
            throws PairException {
        if (device.getBondState() == BluetoothDevice.BOND_BONDED) return;
        // Android 12+: createBond()/getBondState() exigen BLUETOOTH_CONNECT.
        if (needsBtPermission()) {
            throw new PairException(
                "permission_denied: Bluetooth (dispositivos cercanos) — necesario "
                    + "para emparejar el módulo");
        }
        // El discovery activo rompe el emparejado (igual que el connect SPP).
        cancelDiscoverySafe(adapter);

        final String target = device.getAddress();
        final CountDownLatch latch = new CountDownLatch(1);
        BroadcastReceiver bondReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (!BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(intent.getAction())) return;
                BluetoothDevice d = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (d == null || target == null || !target.equals(d.getAddress())) return;
                int state = intent.getIntExtra(
                    BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR);
                // BONDED = listo; NONE = el usuario canceló o el PIN falló.
                // BONDING = sigue en curso (Android muestra el diálogo) → esperar.
                if (state == BluetoothDevice.BOND_BONDED || state == BluetoothDevice.BOND_NONE) {
                    latch.countDown();
                }
            }
        };
        IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
        // broadcast del SISTEMA: exento de NOT_EXPORTED en targetSdk 34.
        ContextCompat.registerReceiver(
            getContext(), bondReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
        try {
            // Solo arrancamos el bond si no está ya en curso (BONDING).
            if (device.getBondState() == BluetoothDevice.BOND_NONE) {
                boolean started = device.createBond();
                if (!started && device.getBondState() == BluetoothDevice.BOND_NONE) {
                    throw new PairException(NO_PAIR_MSG);
                }
            }
            try {
                latch.await(BOND_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw new PairException(NO_PAIR_MSG);
            }
            if (device.getBondState() != BluetoothDevice.BOND_BONDED) {
                throw new PairException(NO_PAIR_MSG);
            }
        } catch (SecurityException se) {
            throw new PairException("permission_denied: " + se.getMessage());
        } finally {
            try {
                getContext().unregisterReceiver(bondReceiver);
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * Abre el SPP de forma ROBUSTA (patrón de campo HC-05/BC04):
     *  1) camino estándar createRfcommSocketToServiceRecord(UUID SPP) +
     *     connect() — lo que funciona en la mayoría de módulos;
     *  2) si el connect() lanza IOException (típico de los clones HC-05 con
     *     SDP pobre que no publican bien el record SPP), FALLBACK a
     *     createRfcommSocket(canal 1) por REFLEXIÓN, el truco conocido para
     *     esos módulos.
     * cancelDiscovery() se llama SIEMPRE antes de CADA connect: un discovery
     * en curso rompe el establecimiento del socket SPP (causa nº1 de fallos
     * intermitentes al conectar en campo).
     */
    @SuppressLint("MissingPermission")
    private BluetoothSocket connectSpp(BluetoothAdapter adapter, BluetoothDevice device)
            throws IOException {
        IOException primary;
        BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
        try {
            cancelDiscoverySafe(adapter);
            socket.connect(); // bloqueante: por eso corre en el executor
            return socket;
        } catch (IOException e) {
            primary = e;
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
        // Fallback HC-05: canal RFCOMM 1 por reflexión.
        try {
            BluetoothSocket fb = (BluetoothSocket) device.getClass()
                .getMethod("createRfcommSocket", int.class)
                .invoke(device, 1);
            cancelDiscoverySafe(adapter);
            fb.connect();
            Log.d(TAG, "SPP conectado por fallback createRfcommSocket(1)");
            return fb;
        } catch (Exception reflect) {
            throw new IOException(
                "SPP no conectó (UUID: " + primary.getMessage()
                    + " · canal 1: " + reflect.getMessage() + ")");
        }
    }

    /** cancelDiscovery() tolerante: el discovery activo rompe el connect SPP. */
    @SuppressLint("MissingPermission")
    private void cancelDiscoverySafe(BluetoothAdapter adapter) {
        try {
            if (adapter != null && adapter.isDiscovering()) adapter.cancelDiscovery();
        } catch (SecurityException ignored) {
        }
    }

    /**
     * Hilo lector: bytes crudos del socket → buffer (drenado por btRead).
     * Un solo hilo, con try/catch: ante IOException/EOF (módulo reiniciado,
     * fuera de rango, ruido) NO crashea — sale limpio y marca el enlace CAÍDO
     * (btConnected=false) para que el driver TS reconecte. Recibe SU propio
     * socket para no pisar el estado de una reconexión ya en curso.
     */
    private void btReadLoop(BluetoothSocket owner, InputStream in) {
        byte[] chunk = new byte[1024];
        while (btRunning) {
            try {
                int n = in.read(chunk);
                if (n < 0) break; // el peer cerró
                if (n > 0) {
                    synchronized (btLock) {
                        appendCapped(btBuffer, chunk, n);
                    }
                }
            } catch (IOException e) {
                if (btRunning) Log.d(TAG, "bt read loop terminado: " + e.getMessage());
                break;
            }
        }
        // El socket murió. Marcar el enlace caído SOLO si sigue siendo el
        // activo: si una reconexión ya instaló otro socket, este cleanup del
        // hilo viejo NO debe pisar el btConnected del nuevo (evita la carrera).
        synchronized (btLock) {
            if (btSocket == owner) btConnected = false;
        }
    }

    @PluginMethod
    public void btRead(PluginCall call) {
        byte[] data;
        boolean connected;
        synchronized (btLock) {
            // Se DRENA el buffer SIEMPRE (aunque el enlace esté caído): así no
            // se pierden los últimos bytes recibidos justo antes de una caída.
            data = btBuffer.toByteArray();
            btBuffer.reset();
            connected = btConnected && btSocket != null;
        }
        JSObject ret = new JSObject();
        ret.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        // Estado REAL del enlace: el driver TS lo usa para disparar la
        // reconexión sin depender de una excepción. NO se rechaza al estar
        // desconectado (evita perder el buffer y ruido de errores).
        ret.put("connected", connected);
        call.resolve(ret);
    }

    /** Estado REAL del enlace SPP (socket abierto + hilo lector vivo). */
    @PluginMethod
    public void btStatus(PluginCall call) {
        boolean connected;
        synchronized (btLock) {
            connected = btConnected && btSocket != null;
        }
        JSObject ret = new JSObject();
        ret.put("connected", connected);
        call.resolve(ret);
    }

    @PluginMethod
    public void btDisconnect(PluginCall call) {
        closeBtLocked();
        call.resolve();
    }

    private void closeBtLocked() {
        synchronized (btLock) {
            btRunning = false;
            btConnected = false;
            if (btSocket != null) {
                try {
                    btSocket.close();
                } catch (IOException ignored) {
                }
                btSocket = null;
            }
            if (btReaderThread != null) {
                btReaderThread.interrupt();
                btReaderThread = null;
            }
            btBuffer.reset();
        }
    }

    // ================================================= discovery de CERCANOS
    // Discovery clásico PROPIO (no dependemos del scan() de @e-is, que en
    // campo — Xiaomi/MIUI — no surtía los no-emparejados): startDiscovery()
    // + ACTION_FOUND van llenando un buffer que el shim sondea con
    // discoveryPoll(); la UI agrega cercanos EN VIVO durante el ciclo
    // (~12 s) hasta ACTION_DISCOVERY_FINISHED.
    //
    // Permisos reales del discovery:
    //  - Android 12+ (S): BLUETOOTH_SCAN runtime (declarado con
    //    neverForLocation en el manifest → NO exige Ubicación encendida).
    //  - Android ≤11: ACCESS_FINE_LOCATION runtime Y ADEMÁS los servicios
    //    de Ubicación del sistema ENCENDIDOS — si están apagados, Android
    //    devuelve el discovery VACÍO sin error (el bug de campo clásico):
    //    se detecta con isLocationEnabled() y se rechaza con "location_off"
    //    para que la UI muestre el aviso accionable.

    /** ¿Los servicios de ubicación del sistema están encendidos? */
    private boolean isLocationEnabled() {
        try {
            LocationManager lm =
                (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return lm.isLocationEnabled();
            }
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            return true; // ante la duda no bloquear la búsqueda
        }
    }

    private boolean needsDiscoveryPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return getPermissionState(BT_ALIAS) != PermissionState.GRANTED;
        }
        return getPermissionState(LOCATION_ALIAS) != PermissionState.GRANTED;
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (needsDiscoveryPermission()) {
            String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? BT_ALIAS : LOCATION_ALIAS;
            requestPermissionForAlias(alias, call, "discoveryPermissionCallback");
            return;
        }
        doStartDiscovery(call);
    }

    @PermissionCallback
    private void discoveryPermissionCallback(PluginCall call) {
        if (needsDiscoveryPermission()) {
            call.reject("permission_denied: búsqueda Bluetooth (dispositivos cercanos)");
            return;
        }
        doStartDiscovery(call);
    }

    @SuppressLint("MissingPermission")
    private void doStartDiscovery(PluginCall call) {
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("bluetooth_off");
            return;
        }
        // Android ≤11: sin Ubicación encendida el discovery llega vacío.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && !isLocationEnabled()) {
            call.reject("location_off");
            return;
        }
        synchronized (discLock) {
            if (adapter.isDiscovering()) adapter.cancelDiscovery();
            discFound.clear();
            discFinished = false;
        }
        if (discReceiver == null) {
            discReceiver = new BroadcastReceiver() {
                @Override
                @SuppressLint("MissingPermission")
                public void onReceive(Context ctx, Intent intent) {
                    String action = intent.getAction();
                    if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                        BluetoothDevice device =
                            intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                        if (device == null || device.getAddress() == null) return;
                        String name = null;
                        try {
                            name = device.getName();
                        } catch (SecurityException ignored) {
                        }
                        if (name == null) {
                            name = intent.getStringExtra(BluetoothDevice.EXTRA_NAME);
                        }
                        JSObject o = new JSObject();
                        o.put("name", name != null ? name : "");
                        o.put("address", device.getAddress());
                        synchronized (discLock) {
                            discFound.put(device.getAddress(), o); // dedupe por MAC
                        }
                    } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(action)) {
                        synchronized (discLock) {
                            discFinished = true;
                        }
                    }
                }
            };
            IntentFilter filter = new IntentFilter();
            filter.addAction(BluetoothDevice.ACTION_FOUND);
            filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
            // broadcasts del SISTEMA: exentos del requisito NOT_EXPORTED de
            // targetSdk 34; EXPORTED evita el lint de flag sin especificar
            ContextCompat.registerReceiver(
                getContext(), discReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
        }
        boolean started = adapter.startDiscovery();
        if (!started) {
            synchronized (discLock) {
                discFinished = true;
            }
            call.reject("No pude iniciar la búsqueda Bluetooth (¿permisos del sistema?)");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("started", true);
        call.resolve(ret);
    }

    /** Cercanos hallados hasta ahora (acumulado, sin duplicados) + ¿terminó? */
    @PluginMethod
    public void discoveryPoll(PluginCall call) {
        JSArray devices = new JSArray();
        boolean finished;
        synchronized (discLock) {
            for (JSObject o : discFound.values()) devices.put(o);
            finished = discFinished;
        }
        JSObject ret = new JSObject();
        ret.put("devices", devices);
        ret.put("finished", finished);
        call.resolve(ret);
    }

    @PluginMethod
    @SuppressLint("MissingPermission")
    public void cancelDiscovery(PluginCall call) {
        BluetoothAdapter adapter = getAdapter();
        try {
            if (adapter != null && adapter.isDiscovering()) adapter.cancelDiscovery();
        } catch (SecurityException ignored) {
        }
        synchronized (discLock) {
            discFinished = true;
        }
        call.resolve();
    }

    /** Aviso accionable: abre los ajustes de Ubicación del sistema. */
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("No pude abrir los ajustes de ubicación: " + e.getMessage());
        }
    }

    // ================================================================= USB

    private UsbManager getUsbManager() {
        return (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
    }

    @PluginMethod
    public void usbDevices(PluginCall call) {
        UsbManager manager = getUsbManager();
        if (manager == null) {
            call.reject("no_device: este equipo no soporta USB host");
            return;
        }
        List<UsbSerialDriver> drivers =
            UsbSerialProber.getDefaultProber().findAllDrivers(manager);
        JSArray devices = new JSArray();
        for (UsbSerialDriver driver : drivers) {
            UsbDevice device = driver.getDevice();
            JSObject o = new JSObject();
            o.put("deviceId", device.getDeviceId());
            o.put("vid", device.getVendorId());
            o.put("pid", device.getProductId());
            String name = Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP
                ? device.getProductName() : null;
            o.put("name", name != null ? name : device.getDeviceName());
            o.put("driver", driver.getClass().getSimpleName()); // Ch34xSerialDriver…
            devices.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("devices", devices);
        call.resolve(ret);
    }

    @PluginMethod
    public void usbConnect(PluginCall call) {
        UsbManager manager = getUsbManager();
        if (manager == null) {
            call.reject("no_device: este equipo no soporta USB host");
            return;
        }
        Integer deviceId = call.getInt("deviceId");
        if (deviceId == null) {
            call.reject("falta 'deviceId' (de GET /api/usb/devices)");
            return;
        }
        UsbSerialDriver driver = findDriver(manager, deviceId);
        if (driver == null) {
            call.reject("no_device: no encuentro el dispositivo USB " + deviceId
                + " (¿se desconectó el cable OTG?)");
            return;
        }
        if (!manager.hasPermission(driver.getDevice())) {
            requestUsbPermission(call, manager, driver);
            return;
        }
        openUsb(call, manager, driver);
    }

    private UsbSerialDriver findDriver(UsbManager manager, int deviceId) {
        for (UsbSerialDriver driver
            : UsbSerialProber.getDefaultProber().findAllDrivers(manager)) {
            if (driver.getDevice().getDeviceId() == deviceId) return driver;
        }
        return null;
    }

    /** Diálogo del sistema "¿Permitir acceso al dispositivo USB?". */
    private void requestUsbPermission(PluginCall call, UsbManager manager,
                                      UsbSerialDriver driver) {
        synchronized (usbLock) {
            if (pendingUsbCall != null) {
                pendingUsbCall.reject("usb_permission: petición reemplazada");
            }
            pendingUsbCall = call;
        }
        Context context = getContext();
        if (usbPermissionReceiver == null) {
            usbPermissionReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    if (!ACTION_USB_PERMISSION.equals(intent.getAction())) return;
                    PluginCall pending;
                    synchronized (usbLock) {
                        pending = pendingUsbCall;
                        pendingUsbCall = null;
                    }
                    if (pending == null) return;
                    boolean granted =
                        intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                    if (!granted) {
                        pending.reject("usb_permission: acceso denegado por el usuario");
                        return;
                    }
                    UsbManager mgr = getUsbManager();
                    Integer devId = pending.getInt("deviceId");
                    UsbSerialDriver drv = devId != null ? findDriver(mgr, devId) : null;
                    if (drv == null) {
                        pending.reject("no_device: el dispositivo USB ya no está");
                        return;
                    }
                    openUsb(pending, mgr, drv);
                }
            };
            ContextCompat.registerReceiver(
                context,
                usbPermissionReceiver,
                new IntentFilter(ACTION_USB_PERMISSION),
                ContextCompat.RECEIVER_NOT_EXPORTED
            );
        }
        int piFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? PendingIntent.FLAG_MUTABLE : 0;
        PendingIntent pi = PendingIntent.getBroadcast(
            context, 0,
            new Intent(ACTION_USB_PERMISSION).setPackage(context.getPackageName()),
            piFlags
        );
        manager.requestPermission(driver.getDevice(), pi);
    }

    private void openUsb(PluginCall call, UsbManager manager, UsbSerialDriver driver) {
        int baudRate = call.getInt("baudRate", 9600);
        int dataBits = call.getInt("dataBits", 8);
        int stopBitsIn = call.getInt("stopBits", 1);
        String parityIn = call.getString("parity", "N");

        int stopBits = stopBitsIn == 2 ? UsbSerialPort.STOPBITS_2 : UsbSerialPort.STOPBITS_1;
        int parity = UsbSerialPort.PARITY_NONE;
        if ("E".equalsIgnoreCase(parityIn)) parity = UsbSerialPort.PARITY_EVEN;
        else if ("O".equalsIgnoreCase(parityIn)) parity = UsbSerialPort.PARITY_ODD;

        try {
            closeUsbLocked();
            UsbDeviceConnection connection = manager.openDevice(driver.getDevice());
            if (connection == null) {
                call.reject("usb_permission: openDevice devolvió null (sin permiso)");
                return;
            }
            UsbSerialPort port = driver.getPorts().get(0);
            port.open(connection);
            port.setParameters(baudRate, dataBits, stopBits, parity);
            SerialInputOutputManager io = new SerialInputOutputManager(
                port,
                new SerialInputOutputManager.Listener() {
                    @Override
                    public void onNewData(byte[] data) {
                        synchronized (usbLock) {
                            appendCapped(usbBuffer, data, data.length);
                        }
                    }

                    @Override
                    public void onRunError(Exception e) {
                        // Cable OTG desconectado o error de bus: cerrar limpio.
                        // El próximo usbRead() responde no_device (la UI pasa a
                        // "sin señal" por el watchdog del motor, sin crash).
                        Log.d(TAG, "usb io error (¿cable desconectado?): " + e.getMessage());
                        synchronized (usbLock) {
                            if (usbIoManager != null) {
                                usbIoManager.stop();
                                usbIoManager = null;
                            }
                            if (usbPort != null) {
                                try {
                                    usbPort.close();
                                } catch (IOException ignored) {
                                }
                                usbPort = null;
                            }
                        }
                    }
                }
            );
            synchronized (usbLock) {
                usbPort = port;
                usbBuffer.reset();
                usbIoManager = io;
            }
            io.start();
            call.resolve();
        } catch (Exception e) {
            closeUsbLocked();
            call.reject("No pude abrir el puerto USB: " + e.getMessage());
        }
    }

    @PluginMethod
    public void usbRead(PluginCall call) {
        byte[] data;
        synchronized (usbLock) {
            if (usbPort == null) {
                call.reject("no_device: USB no conectado");
                return;
            }
            data = usbBuffer.toByteArray();
            usbBuffer.reset();
        }
        JSObject ret = new JSObject();
        ret.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
        call.resolve(ret);
    }

    @PluginMethod
    public void usbDisconnect(PluginCall call) {
        closeUsbLocked();
        call.resolve();
    }

    private void closeUsbLocked() {
        synchronized (usbLock) {
            if (usbIoManager != null) {
                usbIoManager.stop();
                usbIoManager = null;
            }
            if (usbPort != null) {
                try {
                    usbPort.close();
                } catch (IOException ignored) {
                }
                usbPort = null;
            }
            usbBuffer.reset();
        }
    }

    // ============================================================ helpers

    /** Buffer acotado: si nadie drena, se conserva solo la cola. */
    private static void appendCapped(ByteArrayOutputStream buffer, byte[] data, int len) {
        if (buffer.size() + len > MAX_BUFFER) {
            byte[] tail = buffer.toByteArray();
            int keep = Math.max(0, MAX_BUFFER / 4 - len);
            buffer.reset();
            if (keep > 0 && tail.length > keep) {
                buffer.write(tail, tail.length - keep, keep);
            }
        }
        buffer.write(data, 0, len);
    }

    @Override
    protected void handleOnDestroy() {
        closeBtLocked();
        closeUsbLocked();
        if (discReceiver != null) {
            try {
                getContext().unregisterReceiver(discReceiver);
            } catch (Exception ignored) {
            }
            discReceiver = null;
        }
        try {
            BluetoothAdapter adapter = getAdapter();
            if (adapter != null && adapter.isDiscovering()) adapter.cancelDiscovery();
        } catch (Exception ignored) {
        }
        if (usbPermissionReceiver != null) {
            try {
                getContext().unregisterReceiver(usbPermissionReceiver);
            } catch (Exception ignored) {
            }
            usbPermissionReceiver = null;
        }
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
