import React, { useState, useEffect, useRef } from 'react';
import { 
  Usb, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle2, 
  XCircle, 
  Activity, 
  Clock, 
  Cpu, 
  Sliders, 
  Flame, 
  Volume2, 
  Thermometer, 
  Droplets,
  Radio,
  Hourglass
} from 'lucide-react';

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export default function SensorSettingsPanel({ 
  sensorStatus, 
  sensorData, 
  connectionMode, 
  onModeChange, 
  onWebSerialUpdate 
}) {
  // Local state for ports list
  const [ports, setPorts] = useState([]);
  const [selectedPort, setSelectedPort] = useState('COM4');
  const [baudRate, setBaudRate] = useState(115200);
  const [isLoadingPorts, setIsLoadingPorts] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // Web Serial State
  const [webSerialSupported, setWebSerialSupported] = useState(false);
  const [webSerialPort, setWebSerialPort] = useState(null);
  const [webSerialStatus, setWebSerialStatus] = useState('DISCONNECTED');
  const [webSerialPackets, setWebSerialPackets] = useState(0);
  const [webSerialBytes, setWebSerialBytes] = useState(0);
  const [webSerialLastReadingDt, setWebSerialLastReadingDt] = useState(null);
  const [webSerialLastReadingTime, setWebSerialLastReadingTime] = useState(null);
  const [webSerialLastPacket, setWebSerialLastPacket] = useState(null);
  const [webSerialError, setWebSerialError] = useState(null);
  const webSerialReaderRef = useRef(null);
  const webSerialKeepReadingRef = useRef(false);

  // Check Web Serial support
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'serial' in navigator) {
      setWebSerialSupported(true);
    }
  }, []);

  // Fetch available COM ports from backend
  const fetchPorts = async () => {
    setIsLoadingPorts(true);
    try {
      const res = await fetch('/api/sensor/ports');
      if (res.ok) {
        const data = await res.json();
        setPorts(data.ports || []);
        if (data.ports && data.ports.length > 0) {
          if (!selectedPort) {
            const espCandidate = data.ports.find(p => p.is_esp32_hint);
            setSelectedPort(espCandidate ? espCandidate.device : data.ports[0].device);
          }
        }
      }
    } catch (err) {
      console.warn('Error fetching COM ports:', err);
    } finally {
      setIsLoadingPorts(false);
    }
  };

  useEffect(() => {
    fetchPorts();
  }, []);

  // Connect via Python Collector
  const handleConnectPython = async () => {
    if (!selectedPort) {
      alert('Please select a COM port first.');
      return;
    }
    setIsConnecting(true);
    try {
      const res = await fetch('/api/sensor/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: selectedPort, baud_rate: Number(baudRate) })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(`Connection Failed: ${data.detail || 'Could not open serial port'}`);
      }
    } catch (err) {
      alert(`Backend communication error: ${err.message}`);
    } finally {
      setIsConnecting(false);
    }
  };

  // Disconnect Python Collector
  const handleDisconnectPython = async () => {
    try {
      await fetch('/api/sensor/disconnect', { method: 'POST' });
    } catch (err) {
      console.error(err);
    }
  };

  // Connect via Web Serial API
  const handleConnectWebSerial = async () => {
    if (!navigator.serial) {
      alert('Web Serial API is not supported in this browser. Please use Google Chrome or Microsoft Edge.');
      return;
    }

    try {
      setWebSerialStatus('CONNECTING');
      setWebSerialError(null);

      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: Number(baudRate) });

      setWebSerialPort(port);
      setWebSerialStatus('WAITING FOR DATA');
      setWebSerialPackets(0);
      setWebSerialBytes(0);
      setWebSerialLastPacket(null);
      setWebSerialLastReadingDt(null);
      setWebSerialLastReadingTime(null);
      webSerialKeepReadingRef.current = true;

      readWebSerialStream(port);
    } catch (err) {
      console.error('Web Serial Connection Error:', err);
      setWebSerialStatus('ERROR');
      setWebSerialError(err.message || 'Failed to open serial device.');
    }
  };

  // Web Serial reader loop
  const readWebSerialStream = async (port) => {
    let lineBuffer = '';
    const textDecoder = new TextDecoderStream();
    port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    webSerialReaderRef.current = reader;

    try {
      while (webSerialKeepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          setWebSerialBytes(prev => prev + value.length);
          lineBuffer += value;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let parsed = null;
            // 1. JSON
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
              try {
                parsed = JSON.parse(trimmed);
              } catch (e) {}
            } 
            // 2. Human-readable text format
            else if (trimmed.includes('Flame:') && trimmed.includes('Buzzer:')) {
              const flameDet = trimmed.includes('Flame: DETECTED');
              const buzzAct = trimmed.includes('Buzzer: ON');
              const tempMatch = trimmed.match(/Temperature:\s*([0-9.]+)\s*C/);
              const humMatch = trimmed.match(/Humidity:\s*([0-9.]+)\s*%/);
              parsed = {
                device_id: 'PYRO-ESP32',
                temp_c: tempMatch ? parseFloat(tempMatch[1]) : null,
                humidity_pct: humMatch ? parseFloat(humMatch[1]) : null,
                flame_detected: flameDet,
                buzzer_active: buzzAct,
                sensor_status: 'NORMAL',
                raw_line: trimmed
              };
            } 
            // 3. CSV format from pyro_guard.ino
            else if (trimmed.includes(',')) {
              const parts = trimmed.split(',');
              if (parts.length >= 6) {
                const uptime = parseInt(parts[0], 10) || 0;
                const temp = parts[1] && parts[1].trim() !== '' ? parseFloat(parts[1]) : null;
                const hum = parts[2] && parts[2].trim() !== '' ? parseFloat(parts[2]) : null;
                
                // Handle 7-field format (from pyro_guard.ino with empty column at index 3) or 6-field format
                let flame = false;
                let buzz = false;
                if (parts.length >= 7 && parts[3].trim() === '') {
                  flame = parts[4]?.trim() === '1';
                  buzz = parts[5]?.trim() === '1';
                } else {
                  flame = parts[3]?.trim() === '1';
                  buzz = parts[4]?.trim() === '1';
                }

                parsed = {
                  device_id: 'PYRO-ESP32',
                  uptime_s: Math.floor(uptime / 1000),
                  temp_c: temp,
                  temperature_c: temp,
                  humidity_pct: hum,
                  flame_detected: flame,
                  buzzer_active: buzz,
                  buzzer_on: buzz,
                  sensor_status: 'NORMAL',
                  raw_line: trimmed
                };
              }
            }

            if (parsed) {
              const now = new Date();
              setWebSerialLastPacket(parsed);
              setWebSerialPackets(prev => prev + 1);
              setWebSerialLastReadingDt(now);
              setWebSerialLastReadingTime(now.toISOString());
              setWebSerialStatus('CONNECTED');

              // Persist reading to SQLite unified data layer and trigger alarms
              fetch('/api/sensor/telemetry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  device_id: parsed.device_id || 'PYRO-ESP32',
                  uptime_ms: parsed.uptime_s ? parsed.uptime_s * 1000 : undefined,
                  temperature_c: parsed.temp_c,
                  humidity_pct: parsed.humidity_pct,
                  flame_detected: parsed.flame_detected,
                  buzzer_on: parsed.buzzer_active,
                  source: 'web_serial'
                })
              }).catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      setWebSerialStatus('ERROR');
      setWebSerialError(err.message || 'Serial read disrupted.');
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {}
    }
  };

  const handleDisconnectWebSerial = async () => {
    webSerialKeepReadingRef.current = false;
    if (webSerialReaderRef.current) {
      try {
        await webSerialReaderRef.current.cancel();
      } catch (e) {}
    }
    if (webSerialPort) {
      try {
        await webSerialPort.close();
      } catch (e) {}
    }
    setWebSerialPort(null);
    setWebSerialStatus('DISCONNECTED');
  };

  // Compute active variables based on mode
  const isPython = connectionMode === 'python_collector';
  
  // State from unified source or Web Serial
  const activeStatus = isPython ? sensorStatus : webSerialStatus;
  const isPortOpen = isPython ? Boolean(sensorData.is_port_open) : Boolean(webSerialPort);
  const activePort = isPython ? (sensorData.port || selectedPort) : 'Browser USB';
  const activePackets = isPython ? sensorData.packets_received : webSerialPackets;
  const activeBytes = isPython ? sensorData.bytes_received : webSerialBytes;
  const activeLastReading = isPython ? sensorData.last_reading_time : webSerialLastReadingTime;
  const activeReadingAge = isPython ? sensorData.reading_age_seconds : (
    webSerialLastReadingDt ? Math.round((Date.now() - webSerialLastReadingDt.getTime()) / 1000) : null
  );
  const activePacket = isPython ? sensorData.last_packet : webSerialLastPacket;
  const activeError = isPython ? sensorData.last_error : webSerialError;

  // Propagate Web Serial status to App
  useEffect(() => {
    if (!isPython && onWebSerialUpdate) {
      onWebSerialUpdate(activeStatus, {
        status: activeStatus,
        is_port_open: isPortOpen,
        port: 'WebSerial',
        baud_rate: baudRate,
        packets_received: activePackets,
        bytes_received: activeBytes,
        last_reading_time: activeLastReading,
        reading_age_seconds: activeReadingAge,
        last_packet: activePacket,
        last_error: activeError
      });
    }
  }, [isPython, activeStatus, isPortOpen, activePackets, activeBytes, activeLastReading, activePacket, activeError]);

  const getStatusBadgeClass = () => {
    if (activeStatus === 'CONNECTED') return 'status-pill-badge online';
    if (activeStatus === 'WAITING FOR DATA' || activeStatus === 'STALE' || activeStatus === 'CONNECTING') return 'status-pill-badge connecting';
    if (activeStatus === 'ERROR') return 'status-pill-badge error';
    return 'status-pill-badge offline';
  };

  const getDotClass = () => {
    if (activeStatus === 'CONNECTED') return 'status-indicator-dot online';
    if (activeStatus === 'WAITING FOR DATA' || activeStatus === 'STALE' || activeStatus === 'CONNECTING') return 'status-indicator-dot connecting';
    if (activeStatus === 'ERROR') return 'status-indicator-dot error';
    return 'status-indicator-dot offline';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Architecture Identification Banner */}
      <div className="arch-banner">
        <div className="arch-info">
          <div className="arch-title-box">
            <Radio size={16} color="#ef4444" />
            <h3 className="arch-title">Sensor Connection Architecture</h3>
          </div>
          <p className="arch-desc">
            PYROGUARD-H supports both <strong>Local Python Serial Collector</strong> (recommended for background buffering, multi-client LAN access, and automatic reconnect) and <strong>Direct Web Serial API</strong> (direct in-browser USB serial without requiring backend services). Default baud rate is strictly set to <strong style={{ color: '#f87171', fontFamily: 'var(--font-mono)' }}>115200</strong> to match the ESP32 sensor firmware.
          </p>
        </div>

        {/* Mode Selector */}
        <div className="mode-toggle-group">
          <button
            onClick={() => onModeChange('python_collector')}
            className={`mode-btn ${connectionMode === 'python_collector' ? 'active' : ''}`}
          >
            <Cpu size={14} />
            <span>Python Collector</span>
          </button>
          <button
            onClick={() => onModeChange('web_serial')}
            className={`mode-btn ${connectionMode === 'web_serial' ? 'active' : ''}`}
          >
            <Usb size={14} />
            <span>Web Serial (Browser)</span>
          </button>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* Left Card: Hardware Controls */}
        <div className="pyro-card">
          <div className="card-header">
            <div className="card-header-title">
              <Sliders size={18} color="#ef4444" />
              <span>{isPython ? 'Python COM Port Configuration' : 'Web Serial Device Setup'}</span>
            </div>
            {isPython && (
              <button
                onClick={fetchPorts}
                disabled={isLoadingPorts}
                className="btn-secondary"
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
                title="Refresh hardware COM ports"
              >
                <RefreshCw size={13} className={isLoadingPorts ? 'animate-spin' : ''} />
                <span>Scan Ports</span>
              </button>
            )}
          </div>

          {isPython ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div className="form-group">
                <label className="form-label">
                  <span>Target COM Port</span>
                  <span className="form-label-hint">ESP32 / CP210x / FTDI</span>
                </label>
                <select
                  value={selectedPort}
                  onChange={(e) => setSelectedPort(e.target.value)}
                  disabled={isPortOpen}
                  className="pyro-input pyro-select"
                >
                  {ports.length === 0 ? (
                    <option value="">No COM ports detected - Connect ESP32 via USB</option>
                  ) : (
                    ports.map((p) => (
                      <option key={p.device} value={p.device}>
                        {p.device} - {p.description} {p.is_esp32_hint ? '★ (ESP32 / UART)' : ''}
                      </option>
                    ))
                  )}
                </select>
                <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>
                  Autodetects CP210x, CH340, and FTDI USB-to-UART bridges plugged into this machine.
                </span>
              </div>

              <div className="form-group">
                <label className="form-label">
                  <span>Baud Rate (Default: 115200)</span>
                  <span className="form-label-hint">Firmware Standard</span>
                </label>
                <select
                  value={baudRate}
                  onChange={(e) => setBaudRate(Number(e.target.value))}
                  disabled={isPortOpen}
                  className="pyro-input pyro-select"
                >
                  {BAUD_RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate} baud {rate === 115200 ? '(Firmware Standard)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ paddingTop: '0.5rem' }}>
                {isPortOpen ? (
                  <button
                    onClick={handleDisconnectPython}
                    className="btn-danger-outline"
                    style={{ width: '100%' }}
                  >
                    <XCircle size={16} />
                    <span>Disconnect Port ({activePort})</span>
                  </button>
                ) : (
                  <button
                    onClick={handleConnectPython}
                    disabled={isConnecting || ports.length === 0}
                    className="btn-primary"
                    style={{ width: '100%' }}
                  >
                    <CheckCircle2 size={16} />
                    <span>{isConnecting ? 'Opening Port...' : `Connect Device (${selectedPort || 'Select Port'})`}</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              {!webSerialSupported ? (
                <div className="diagnostic-box danger">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
                    <AlertTriangle size={16} />
                    <span>Web Serial Not Supported</span>
                  </div>
                  <p>
                    Your current browser does not support the Web Serial API. Please use Google Chrome, Microsoft Edge, or switch to <strong>Python Collector</strong> mode.
                  </p>
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label">
                      <span>Baud Rate (Default: 115200)</span>
                    </label>
                    <select
                      value={baudRate}
                      onChange={(e) => setBaudRate(Number(e.target.value))}
                      disabled={isPortOpen}
                      className="pyro-input pyro-select"
                    >
                      {BAUD_RATES.map((rate) => (
                        <option key={rate} value={rate}>
                          {rate} baud {rate === 115200 ? '(Firmware Standard)' : ''}
                        </option>
                      ))}
                    </select>
                    <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>
                      Web Serial prompts browser-level USB permissions on click.
                    </span>
                  </div>

                  <div style={{ paddingTop: '0.5rem' }}>
                    {isPortOpen ? (
                      <button
                        onClick={handleDisconnectWebSerial}
                        className="btn-danger-outline"
                        style={{ width: '100%' }}
                      >
                        <XCircle size={16} />
                        <span>Disconnect Browser Serial</span>
                      </button>
                    ) : (
                      <button
                        onClick={handleConnectWebSerial}
                        className="btn-primary"
                        style={{ width: '100%' }}
                      >
                        <Usb size={16} />
                        <span>Prompt & Connect USB Device</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Connection Error Message */}
          {activeError && (
            <div className="diagnostic-box danger">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
                <AlertTriangle size={16} />
                <span>Device Communication Error</span>
              </div>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{activeError}</p>
              <span style={{ fontSize: '0.725rem', opacity: 0.85 }}>
                Ensure no other tool (Arduino IDE Serial Monitor, Cura, etc.) is holding this COM port.
              </span>
            </div>
          )}

          {/* Waiting for Data Notice */}
          {activeStatus === 'WAITING FOR DATA' && (
            <div className="diagnostic-box warning">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
                <Hourglass size={16} />
                <span>Port Open — Waiting for Telemetry</span>
              </div>
              <p style={{ fontSize: '0.75rem' }}>
                USB port <strong style={{ color: 'var(--text-primary)' }}>{activePort}</strong> is open at 115200 baud. Waiting for the ESP32 firmware to emit initial sensor packets.
              </p>
            </div>
          )}
        </div>

        {/* Right Card: Telemetry Metrics & Readings */}
        <div className="pyro-card">
          <div className="card-header">
            <div className="card-header-title">
              <Activity size={18} color="#0284c7" />
              <span>Device Status & Telemetry</span>
            </div>

            <div className={getStatusBadgeClass()}>
              <span className={getDotClass()} />
              <span>{activeStatus}</span>
            </div>
          </div>

          {/* Metric Tiles */}
          <div className="metric-strip">
            <div className="metric-tile">
              <span className="metric-label">Packets Ingested</span>
              <span className="metric-value">{activePackets}</span>
            </div>

            <div className="metric-tile">
              <span className="metric-label">Data Volume</span>
              <span className="metric-value">{(activeBytes / 1024).toFixed(1)} <small style={{ fontSize: '0.75rem', fontWeight: 400 }}>KB</small></span>
            </div>

            <div className="metric-tile">
              <span className="metric-label">Stream Health</span>
              <span className={`metric-value ${
                activeStatus === 'CONNECTED' ? 'highlight-green' : 
                activeStatus === 'WAITING FOR DATA' || activeStatus === 'STALE' ? 'highlight-amber' : ''
              }`} style={{ fontSize: '0.925rem' }}>
                {activeStatus === 'CONNECTED' ? '✓ Active Stream' :
                 activeStatus === 'WAITING FOR DATA' ? '⏳ Waiting Data' :
                 activeStatus === 'STALE' ? `⚠ Stale (${activeReadingAge}s)` :
                 activeStatus === 'ERROR' ? '✗ Port Error' : 'Offline'}
              </span>
            </div>
          </div>

          {/* Last Reading Timestamp */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', padding: '0.5rem 0.85rem', borderRadius: '8px', fontSize: '0.75rem' }}>
            <span style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem', fontFamily: 'var(--font-mono)' }}>
              <Clock size={13} />
              <span>Last Reading:</span>
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
              {activeLastReading ? `${new Date(activeLastReading).toLocaleTimeString()} (${activeReadingAge}s ago)` : 'None received'}
            </span>
          </div>

          {/* Active Sensor Tiles (2x2 Grid) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.725rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
              Live Hardware Sensor Stream
            </span>

            {activePacket ? (
              <div className="sensor-readings-grid">
                <div className="sensor-tile">
                  <div className="sensor-tile-icon temp">
                    <Thermometer size={20} />
                  </div>
                  <div className="sensor-tile-data">
                    <span className="sensor-tile-label">Temperature</span>
                    <span className="sensor-tile-value">
                      {activePacket.temp_c !== null && activePacket.temp_c !== undefined 
                        ? `${activePacket.temp_c} °C` 
                        : (activePacket.temperature_c !== undefined ? `${activePacket.temperature_c} °C` : 'N/A')}
                    </span>
                  </div>
                </div>

                <div className="sensor-tile">
                  <div className="sensor-tile-icon humidity">
                    <Droplets size={20} />
                  </div>
                  <div className="sensor-tile-data">
                    <span className="sensor-tile-label">Humidity</span>
                    <span className="sensor-tile-value">
                      {activePacket.humidity_pct !== null && activePacket.humidity_pct !== undefined 
                        ? `${activePacket.humidity_pct} %` 
                        : (activePacket.humidity !== undefined ? `${activePacket.humidity} %` : 'N/A')}
                    </span>
                  </div>
                </div>

                <div className="sensor-tile" style={{ border: activePacket.flame_detected ? '1px solid #ef4444' : '1px solid var(--border-subtle)' }}>
                  <div className={`sensor-tile-icon ${activePacket.flame_detected ? 'flame-danger' : 'flame-ok'}`}>
                    <Flame size={20} />
                  </div>
                  <div className="sensor-tile-data">
                    <span className="sensor-tile-label">Flame Status</span>
                    <span className="sensor-tile-value" style={{ color: activePacket.flame_detected ? '#ef4444' : '#34d399', fontSize: '1rem' }}>
                      {activePacket.flame_detected ? 'FIRE DETECTED' : 'CLEAR'}
                    </span>
                  </div>
                </div>

                <div className="sensor-tile">
                  <div className={`sensor-tile-icon buzzer ${activePacket.buzzer_active ? 'active' : ''}`}>
                    <Volume2 size={20} />
                  </div>
                  <div className="sensor-tile-data">
                    <span className="sensor-tile-label">Physical Buzzer</span>
                    <span className="sensor-tile-value" style={{ color: activePacket.buzzer_active ? '#fbbf24' : '#ffffff', fontSize: '1rem' }}>
                      {activePacket.buzzer_active ? 'ACTIVE' : 'SILENT'}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: '1.5rem', textAlign: 'center', background: 'rgba(2, 6, 23, 0.5)', border: '1px dashed var(--border-subtle)', borderRadius: '10px', color: 'var(--text-muted)', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                {activeStatus === 'WAITING FOR DATA' 
                  ? 'Port open. Awaiting incoming readings from ESP32...' 
                  : 'No active sensor stream. Connect the ESP32 USB device above to begin streaming real sensor packets.'}
              </div>
            )}
          </div>

          {/* Raw Telemetry Inspector */}
          {activePacket && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.675rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
                Raw Telemetry Stream ({activePacket.raw_line ? 'CSV/Text' : 'NDJSON'})
              </span>
              <pre className="telemetry-code-block">{JSON.stringify(activePacket, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
