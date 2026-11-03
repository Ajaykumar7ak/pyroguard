import React, { useState, useEffect } from 'react';
import { 
  Wifi, 
  Server, 
  ShieldCheck, 
  Cpu, 
  Radio, 
  Layers, 
  CheckCircle, 
  AlertCircle, 
  Laptop
} from 'lucide-react';

export default function NetworkDiagnosticsPanel() {
  const [diagnostics, setDiagnostics] = useState(null);

  useEffect(() => {
    fetch('/api/network/diagnostics')
      .then(res => res.json())
      .then(data => {
        setDiagnostics(data);
      })
      .catch(err => {
        console.warn('Network diagnostics error:', err);
      });
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Network Portability & Multi-Client Access Card */}
      <div className="pyro-card">
        <div className="card-header">
          <div className="card-header-title">
            <Wifi size={18} color="#ef4444" />
            <span>Local Wi-Fi & Network Portability Diagnostics</span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
          <div className="metric-tile" style={{ padding: '1rem' }}>
            <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Laptop size={14} color="#60a5fa" /> Host Workstation Name
            </span>
            <span className="metric-value" style={{ fontSize: '1.1rem' }}>
              {diagnostics ? diagnostics.hostname : 'Detecting...'}
            </span>
            <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>Windows Workstation Gateway</span>
          </div>

          <div className="metric-tile" style={{ padding: '1rem' }}>
            <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Radio size={14} color="#34d399" /> Local Host IPv4 Addresses
            </span>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.95rem', fontWeight: 700, color: '#34d399' }}>
              {diagnostics && diagnostics.host_ips && diagnostics.host_ips.length > 0 ? (
                diagnostics.host_ips.map((ip) => <div key={ip}>{ip}</div>)
              ) : (
                <div>127.0.0.1</div>
              )}
            </div>
            <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>Local Area Network (LAN)</span>
          </div>

          <div className="metric-tile" style={{ padding: '1rem' }}>
            <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <ShieldCheck size={14} color="#fbbf24" /> Cloud Independence
            </span>
            <span className="metric-value highlight-green" style={{ fontSize: '1.1rem' }}>
              100% Offline Capable
            </span>
            <span style={{ fontSize: '0.725rem', color: '#34d399' }}>
              ✓ Operates fully without active internet connection.
            </span>
          </div>
        </div>

        {/* Subnet Compatibility Check */}
        {diagnostics && (
          <div className={`diagnostic-box ${diagnostics.is_on_same_subnet ? 'success' : 'warning'}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
              {diagnostics.is_on_same_subnet ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
              <span>{diagnostics.is_on_same_subnet ? 'Subnet Alignment Verified' : 'Subnet Mismatch Notice'}</span>
            </div>
            <p style={{ fontSize: '0.775rem' }}>
              Host PC is listening on subnet{' '}
              <code style={{ background: 'rgba(0,0,0,0.4)', padding: '0.15rem 0.4rem', borderRadius: '4px', color: '#ffffff' }}>
                {diagnostics.matching_host_ip || diagnostics.host_ips?.[0] || '127.0.0.1'}
              </code>
              , target camera destination is set to{' '}
              <code style={{ background: 'rgba(0,0,0,0.4)', padding: '0.15rem 0.4rem', borderRadius: '4px', color: '#ffffff' }}>
                {diagnostics.camera_target_ip}
              </code>
              .
            </p>
            {!diagnostics.is_on_same_subnet && (
              <span style={{ fontSize: '0.725rem', opacity: 0.9 }}>
                Ensure both the ESP32-CAM and this PC are connected to the same Wi-Fi router / hotspot so they can communicate across the local network.
              </span>
            )}
          </div>
        )}
      </div>

      {/* Hardware Mapping & Architecture Table */}
      <div className="pyro-card">
        <div className="card-header">
          <div className="card-header-title">
            <Layers size={18} color="#0284c7" />
            <span>Hardware Architecture & Pinout Mapping</span>
          </div>
        </div>

        <div className="dashboard-grid">
          {/* ESP32 Sensor Hardware Contract */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Cpu size={15} color="#0284c7" /> 1. Sensor ESP32 Hardware Contract
            </span>

            <div style={{ background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.65rem', fontSize: '0.775rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Baud Rate:</span>
                <strong style={{ color: '#059669', fontFamily: 'var(--font-mono)' }}>115200 (Default)</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>DHT22 (Temp / Humidity):</span>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>GPIO 4</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Flame Sensor (Digital OUT):</span>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>GPIO 27 / GPIO 14</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Warning Buzzer:</span>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>GPIO 26 / GPIO 12</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Payload Ingestion:</span>
                <span style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)' }}>JSON, CSV, & Text</span>
              </div>
            </div>
          </div>

          {/* ESP32-CAM Hardware Contract */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Server size={15} color="#0284c7" /> 2. ESP32-CAM Stream Contract
            </span>

            <div style={{ background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.65rem', fontSize: '0.775rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Camera Module:</span>
                <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>AI-Thinker OV2640</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Default Stream Endpoint:</span>
                <strong style={{ color: '#d97706', fontFamily: 'var(--font-mono)' }}>http://&lt;IP&gt;:81/stream</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Backend Stream Proxy:</span>
                <strong style={{ color: '#059669', fontFamily: 'var(--font-mono)' }}>/api/camera/stream</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>CORS / PNA Bridge:</span>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>FastAPI Proxy Engine</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>Flash LED Pin:</span>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>GPIO 4</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
