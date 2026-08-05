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
import android.os.Build;
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
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
        )
    }
)
public class PorciSerialPlugin extends Plugin {

    static final String BT_ALIAS = "bluetooth";
    private static final String TAG = "PorciSerial";
    private static final UUID SPP_UUID =
        UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final String ACTION_USB_PERMISSION = "com.porcipeso.app.USB_PERMISSION";
    private static final int MAX_BUFFER = 64 * 1024;

    private final ExecutorService executor = Executors.newCachedThreadPool();

    // ------------------------------------------------------------ estado BT
    private final Object btLock = new Object();
    private BluetoothSocket btSocket;
    private Thread btReaderThread;
    private final ByteArrayOutputStream btBuffer = new ByteArrayOutputStream();
    private volatile boolean btRunning = false;

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
                BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SPP_UUID);
                adapter.cancelDiscovery(); // el discovery activo rompe el connect SPP
                socket.connect(); // bloqueante: por eso corre en el executor
                InputStream in = socket.getInputStream();
                synchronized (btLock) {
                    btSocket = socket;
                    btBuffer.reset();
                    btRunning = true;
                    btReaderThread = new Thread(() -> btReadLoop(in), "porciserial-bt");
                    btReaderThread.start();
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject("permission_denied: " + e.getMessage());
            } catch (IOException e) {
                call.reject("No pude conectar al Bluetooth " + address + ": " + e.getMessage());
            }
        });
    }

    /** Hilo lector: bytes crudos del socket → buffer (drenado por btRead). */
    private void btReadLoop(InputStream in) {
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
    }

    @PluginMethod
    public void btRead(PluginCall call) {
        byte[] data;
        synchronized (btLock) {
            if (btSocket == null) {
                call.reject("no_device: Bluetooth no conectado");
                return;
            }
            data = btBuffer.toByteArray();
            btBuffer.reset();
        }
        JSObject ret = new JSObject();
        ret.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
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
