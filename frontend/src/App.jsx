import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import OverviewPanel from './components/OverviewPanel';
import SensorSettingsPanel from './components/SensorSettingsPanel';
import CameraSettingsPanel from './components/CameraSettingsPanel';
import NetworkDiagnosticsPanel from './components/NetworkDiagnosticsPanel';
import TelemetryHistoryPanel from './components/TelemetryHistoryPanel';
import CloudBackupPanel from './components/CloudBackupPanel';
import { Flame, ArrowRight } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  
  // Unified single-source sensor status & telemetry
  const [sensorStatus, setSensorStatus] = useState('DISCONNECTED');
  const [sensorData, setSensorData] = useState({
    status: 'DISCONNECTED',
    is_port_open: false,
    port: '',
    baud_rate: 115200,
    packets_received: 0,
    bytes_received: 0,
    last_reading_time: null,
    reading_age_seconds: null,
    last_packet: null,
    last_error: null
  });

  const [activeConnectionMode, setActiveConnectionMode] = useState('python_collector');
  const [cameraStatus, setCameraStatus] = useState('Offline');
  const [dbStatus, setDbStatus] = useState(null);
  const [cloudStatus, setCloudStatus] = useState(null);

  // Safe background camera status check (~10s) using lightweight /api/camera/status
  useEffect(() => {
    let isMounted = true;
    let inFlight = false;

    const checkCamera = async () => {
      if (inFlight || !isMounted) return;
      inFlight = true;
      try {
        const res = await fetch('/api/camera/status');
        if (res.ok && isMounted) {
          const data = await res.json();
          setCameraStatus(data.status || 'Offline');
        } else if (isMounted) {
          setCameraStatus('Offline');
        }
      } catch (err) {
        if (isMounted) {
          setCameraStatus('Offline');
        }
      } finally {
        inFlight = false;
      }
    };

    checkCamera();
    const interval = setInterval(checkCamera, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Poll database status periodically
  useEffect(() => {
    let isMounted = true;
    const fetchDb = async () => {
      try {
        const res = await fetch('/api/database/status');
        if (res.ok && isMounted) {
          const data = await res.json();
          setDbStatus(data);
        }
      } catch (e) {
        // Backend momentarily restarting
      }
    };
    fetchDb();
    const interval = setInterval(fetchDb, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Poll cloud backup status periodically
  useEffect(() => {
    let isMounted = true;
    const fetchCloud = async () => {
      try {
        const res = await fetch('/api/cloud/status');
        if (res.ok && isMounted) {
          const data = await res.json();
          setCloudStatus(data);
        }
      } catch (e) {
        // Backend momentarily restarting
      }
    };
    fetchCloud();
    const interval = setInterval(fetchCloud, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // Real-time WebSocket telemetry subscriber with auto-reconnect
  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let isCancelled = false;

    const connectWebSocket = () => {
      if (isCancelled) return;
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;
        ws = new WebSocket(wsUrl);

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'telemetry' && msg.data) {
              setSensorData(prev => ({
                ...prev,
                last_packet: msg.data,
                last_reading_time: msg.data.timestamp_utc,
                packets_received: prev.packets_received + 1
              }));
            } else if (msg.type === 'init') {
              if (msg.latest_reading) {
                setSensorData(prev => ({ ...prev, last_packet: msg.latest_reading }));
              }
            }
          } catch (err) {
            // Non-JSON or keep-alive message
          }
        };

        ws.onclose = () => {
          if (!isCancelled) {
            reconnectTimer = setTimeout(connectWebSocket, 3000);
          }
        };

        ws.onerror = () => {
          if (ws) ws.close();
        };
      } catch (e) {
        if (!isCancelled) {
          reconnectTimer = setTimeout(connectWebSocket, 3000);
        }
      }
    };

    connectWebSocket();

    return () => {
      isCancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, []);

  // Poll backend collector status periodically when using Python collector
  useEffect(() => {
    let isMounted = true;

    const fetchSensorStatus = async () => {
      if (activeConnectionMode !== 'python_collector') return;
      try {
        const res = await fetch('/api/sensor/status');
        if (res.ok && isMounted) {
          const data = await res.json();
          setSensorData(data);
          setSensorStatus(data.status || 'DISCONNECTED');
        }
      } catch (err) {
        // Backend momentarily restarting
      }
    };

    fetchSensorStatus();
    const interval = setInterval(fetchSensorStatus, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeConnectionMode]);

  // Handler for Web Serial status updates (when user selects Web Serial mode)
  const handleWebSerialStateChange = (status, data) => {
    if (activeConnectionMode === 'web_serial') {
      setSensorStatus(status);
      setSensorData(data);
    }
  };

  const latestTelemetry = sensorData.last_packet;

  return (
    <div className="app-wrapper">
      {/* Sticky Header - Consumes the exact same sensorStatus, dbStatus, and cloudStatus */}
      <Header
        sensorStatus={sensorStatus}
        cameraStatus={cameraStatus}
        dbStatus={dbStatus}
        cloudStatus={cloudStatus}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />

      {/* Main Container */}
      <main className="main-container">
        {/* Critical Flame Hazard Alert Banner */}
        {latestTelemetry && latestTelemetry.flame_detected && (
          <div className="hazard-banner">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
              <div style={{ background: '#ef4444', color: '#ffffff', padding: '0.65rem', borderRadius: '8px' }}>
                <Flame size={24} />
              </div>
              <div>
                <strong style={{ fontSize: '1.05rem', fontFamily: 'var(--font-mono)', letterSpacing: '0.02em', display: 'block' }}>
                  CRITICAL HAZARD: FLAME DETECTED BY SENSOR NODE
                </strong>
                <span style={{ fontSize: '0.75rem', color: '#fca5a5', display: 'block', marginTop: '0.2rem' }}>
                  Node ID: {latestTelemetry.device_id || 'PYRO-ESP32'} | Buzzer State: ACTIVE | Status: CRITICAL
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <button 
                onClick={() => setActiveTab('history')}
                className="btn-pager"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.2)', padding: '0.4rem 0.85rem' }}
              >
                <span>Audit Log</span>
                <ArrowRight size={13} />
              </button>
              <span style={{ background: '#ef4444', color: '#ffffff', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 700, padding: '0.4rem 0.85rem', borderRadius: '6px' }}>
                HAZARD ALERT
              </span>
            </div>
          </div>
        )}

        {/* Tab Routing with persistent DOM to prevent browser socket churn and unmount socket drops */}
        <div style={{ display: activeTab === 'overview' ? 'block' : 'none' }}>
          <OverviewPanel 
            sensorStatus={sensorStatus}
            sensorData={sensorData}
            cameraStatus={cameraStatus}
            dbStatus={dbStatus}
            cloudStatus={cloudStatus}
            setActiveTab={setActiveTab}
          />
        </div>

        <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}>
          <SensorSettingsPanel 
            sensorStatus={sensorStatus}
            sensorData={sensorData}
            connectionMode={activeConnectionMode}
            onModeChange={setActiveConnectionMode}
            onWebSerialUpdate={handleWebSerialStateChange}
          />
        </div>

        <div style={{ display: activeTab === 'history' ? 'block' : 'none' }}>
          <TelemetryHistoryPanel />
        </div>

        <div style={{ display: activeTab === 'cloud' ? 'block' : 'none' }}>
          <CloudBackupPanel initialCloudStatus={cloudStatus} />
        </div>

        <div style={{ display: activeTab === 'camera' ? 'block' : 'none' }}>
          <CameraSettingsPanel onCameraStatusChange={setCameraStatus} />
        </div>

        <div style={{ display: activeTab === 'diagnostics' ? 'block' : 'none' }}>
          <NetworkDiagnosticsPanel />
        </div>
      </main>

      {/* Footer */}
      <footer className="pyro-footer">
        <div className="footer-content">
          <span>PYROGUARD-H • Industrial Safety Command Center</span>
          <span style={{ color: 'var(--text-muted)' }}>Local-First Hazard Telemetry & Real-Time Computer Vision Compliance</span>
        </div>
      </footer>
    </div>
  );
}
