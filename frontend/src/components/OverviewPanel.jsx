import React, { useState, useEffect, useCallback } from 'react';
import { 
  Flame, 
  Thermometer, 
  Droplets, 
  Volume2, 
  VolumeX, 
  Video, 
  Database, 
  Cloud, 
  Cpu, 
  Wifi, 
  Clock, 
  ShieldAlert, 
  ShieldCheck, 
  AlertTriangle, 
  RefreshCw, 
  CheckCircle2, 
  ArrowRight,
  Maximize2,
  ExternalLink,
  Layers,
  Activity,
  AlertOctagon
} from 'lucide-react';
import PPEComplianceCockpit from './PPEComplianceCockpit';

export default function OverviewPanel({ 
  sensorStatus, 
  sensorData, 
  cameraStatus, 
  dbStatus, 
  cloudStatus, 
  setActiveTab 
}) {
  // Camera Preview State
  const [streamMode, setStreamMode] = useState('proxy'); // 'proxy' (MJPEG) or 'snapshot_refresh'
  const [cameraIp, setCameraIp] = useState('10.131.84.41');
  const [previewKey, setPreviewKey] = useState(Date.now());
  const [imageError, setImageError] = useState(false);
  const [snapshotSrc, setSnapshotSrc] = useState('/api/camera/capture');
  const retryTimerRef = React.useRef(null);
  const imgRef = React.useRef(null);

  // Active Alarms State
  const [activeAlarms, setActiveAlarms] = useState([]);
  const [isLoadingAlarms, setIsLoadingAlarms] = useState(false);
  const [acknowledgingId, setAcknowledgingId] = useState(null);

  // Load Camera IP from backend config or localStorage
  useEffect(() => {
    let isMounted = true;
    const fetchCameraConfig = async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok && isMounted) {
          const cfg = await res.json();
          if (cfg.camera_ip) setCameraIp(cfg.camera_ip);
          if (cfg.camera_stream_mode) setStreamMode(cfg.camera_stream_mode);
        }
      } catch (e) {
        // Fallback to localStorage if any
        const saved = localStorage.getItem('pyroguard_cam_ip');
        if (saved && isMounted) setCameraIp(saved);
      }
    };
    fetchCameraConfig();
    return () => { isMounted = false; };
  }, []);

  // Cleanup retry timer and abort streaming socket on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (imgRef.current) {
        imgRef.current.src = "";
      }
    };
  }, []);

  const handleReload = () => {
    if (imgRef.current) {
      imgRef.current.src = "";
    }
    setImageError(false);
    setTimeout(() => {
      setPreviewKey(Date.now());
    }, 40);
  };

  // Auto-recovery handler for stream errors (prevents permanent error lockouts)
  const handleStreamError = () => {
    setImageError(true);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => {
      setImageError(false);
      setPreviewKey(Date.now());
    }, 2000);
  };

  // Snapshot refresh loop if streamMode is 'snapshot_refresh'
  useEffect(() => {
    if (streamMode !== 'snapshot_refresh') return;
    const interval = setInterval(() => {
      setSnapshotSrc(`/api/camera/capture?t=${Date.now()}`);
    }, 750);
    return () => clearInterval(interval);
  }, [streamMode]);

  // Fetch Active Alarms
  const fetchActiveAlarms = useCallback(async () => {
    setIsLoadingAlarms(true);
    try {
      const res = await fetch('/api/alarms?active_only=true&limit=10');
      if (res.ok) {
        const data = await res.json();
        setActiveAlarms(data.alarms || []);
      }
    } catch (err) {
      console.error('Failed to load active alarms for overview:', err);
    } finally {
      setIsLoadingAlarms(false);
    }
  }, []);

  useEffect(() => {
    fetchActiveAlarms();
    const interval = setInterval(fetchActiveAlarms, 4000);
    return () => clearInterval(interval);
  }, [fetchActiveAlarms]);

  // Quick Acknowledge from Overview Cockpit
  const handleQuickAck = async (eventId) => {
    setAcknowledgingId(eventId);
    try {
      const res = await fetch(`/api/alarms/${eventId}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: 'Acknowledged via Operator Cockpit Overview' })
      });
      if (res.ok) {
        fetchActiveAlarms();
      }
    } catch (e) {
      console.error('Failed to acknowledge alarm:', e);
    } finally {
      setAcknowledgingId(null);
    }
  };

  // Telemetry Calculations
  const latest = sensorData?.last_packet;
  const isConnected = sensorStatus === 'CONNECTED';
  const hasTelemetry = latest && (latest.temperature_c !== null && latest.temperature_c !== undefined);

  // Freshness calculation
  const getFreshness = () => {
    if (!latest?.timestamp_utc) {
      return { label: 'NO DATA', state: 'offline', detail: 'Awaiting sensor stream' };
    }
    const readingTime = new Date(latest.timestamp_utc).getTime();
    const now = Date.now();
    const ageSec = Math.max(0, Math.round((now - readingTime) / 1000));

    if (!isConnected || sensorStatus === 'DISCONNECTED') {
      return { label: 'DISCONNECTED', state: 'offline', detail: `Last seen ${ageSec}s ago` };
    }
    if (ageSec <= 5) {
      return { label: 'LIVE', state: 'live', detail: `${ageSec}s ago` };
    }
    if (ageSec <= 30) {
      return { label: 'STALE', state: 'stale', detail: `${ageSec}s ago` };
    }
    return { label: 'DELAYED', state: 'stale', detail: `${ageSec}s ago` };
  };

  const freshness = getFreshness();

  // Active Stream URL
  const activeStreamSrc = streamMode === 'snapshot_refresh'
    ? snapshotSrc
    : streamMode === 'ai_hud'
    ? `/api/ppe/stream?t=${previewKey}`
    : `/api/camera/stream?client=overview&t=${previewKey}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      {/* Cockpit Status Banner */}
      <div className="arch-banner" style={{ borderLeft: activeAlarms.length > 0 ? '4px solid #ef4444' : '4px solid #10b981' }}>
        <div className="arch-info">
          <div className="arch-title-box">
            {activeAlarms.length > 0 ? (
              <AlertOctagon size={20} color="#ef4444" className="animate-pulse" />
            ) : (
              <ShieldCheck size={20} color="#10b981" />
            )}
            <h2 style={{ fontSize: '1.05rem', fontWeight: 700, letterSpacing: '0.02em', color: '#0f172a' }}>
              OPERATOR COCKPIT • UNIFIED HAZARD MONITORING
            </h2>
            <span className={`status-pill-badge ${activeAlarms.length > 0 ? 'error' : 'online'}`}>
              {activeAlarms.length > 0 ? `${activeAlarms.length} HAZARD ACTIVE` : 'ALL SYSTEMS NOMINAL'}
            </span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
            Real-time multisensor aggregation engine. Synchronized local SQLite records, autonomous hardware buzzer supervision, and low-latency video surveillance.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button 
            onClick={() => setActiveTab('history')}
            className="btn-pager"
            style={{ padding: '0.45rem 0.85rem' }}
          >
            <Activity size={14} />
            <span>Detailed Alarms & Audit</span>
            <ArrowRight size={13} />
          </button>
        </div>
      </div>

      {/* Main Cockpit Split Grid */}
      <div className="cockpit-grid">
        
        {/* Left Column: Live Camera Video Screen + Feed Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="pyro-card" style={{ padding: '1.25rem' }}>
            <div className="card-header" style={{ marginBottom: '1rem' }}>
              <div className="card-header-title">
                <Video size={18} color="#ef4444" />
                <span>ESP32-CAM Live Hazard Surveillance</span>
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span className={`status-pill-badge ${cameraStatus === 'Online' ? 'online' : cameraStatus === 'Checking' ? 'connecting' : 'offline'}`}>
                  <span className={`status-indicator-dot ${cameraStatus === 'Online' ? 'online' : cameraStatus === 'Checking' ? 'connecting' : 'offline'}`} />
                  <span>CAM: {cameraStatus}</span>
                </span>

                <button
                  onClick={handleReload}
                  className="btn-secondary"
                  style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem' }}
                  title="Reload Camera Feed"
                >
                  <RefreshCw size={13} />
                  <span>Reload</span>
                </button>
              </div>
            </div>

            {/* Video Viewport */}
            <div className="camera-preview-wrapper" style={{ minHeight: '280px' }}>
              {!imageError ? (
                <img
                  ref={imgRef}
                  key={previewKey}
                  src={activeStreamSrc}
                  alt="ESP32-CAM Live Feed"
                  className="camera-video-stream"
                  onError={handleStreamError}
                />
              ) : null}

              {/* HUD Overlay Badges */}
              {!imageError && (
                <>
                  <div className="camera-hud-badge">
                    <span className={`status-indicator-dot ${cameraStatus === 'Online' ? 'online' : 'connecting'}`} />
                    <span>
                      {streamMode === 'ai_hud' 
                        ? 'AI PPE HUD STREAM (YOLOv8)' 
                        : streamMode === 'proxy' 
                        ? 'MJPEG STREAM (PORT 81)' 
                        : 'SNAPSHOT REFRESH (PORT 80)'}
                    </span>
                  </div>

                  <div style={{
                    position: 'absolute',
                    bottom: '0.75rem',
                    right: '0.75rem',
                    background: 'rgba(2, 6, 23, 0.85)',
                    backdropFilter: 'blur(8px)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '6px',
                    padding: '0.25rem 0.65rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.675rem',
                    color: '#94a3b8'
                  }}>
                    IP: {cameraIp} • PROXY BRIDGE
                  </div>
                </>
              )}

              {/* Stream Fallback / Error Screen */}
              {imageError && (
                <div className="camera-fallback-screen">
                  <div style={{ padding: '0.75rem', borderRadius: '50%', background: 'rgba(239, 68, 68, 0.12)', color: '#f87171' }}>
                    <Video size={28} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff' }}>Camera Stream Feed Offline</h3>
                    <span style={{ fontSize: '0.725rem', color: 'var(--text-secondary)', display: 'block', marginTop: '0.2rem' }}>
                      Target <code style={{ color: '#f87171', fontFamily: 'var(--font-mono)' }}>{cameraIp}</code> did not respond to stream request
                    </span>
                  </div>

                  <div className="fallback-checklist" style={{ maxWidth: '380px' }}>
                    <strong>ESP32-CAM Diagnostics:</strong>
                    <div>• Hardware stream is restricted to 1 active client.</div>
                    <div>• Close any browser tab directly viewing <code style={{ color: '#fff' }}>http://{cameraIp}/</code>.</div>
                    <div>• Or switch below to snapshot refresh mode.</div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button
                      onClick={() => {
                        setStreamMode('snapshot_refresh');
                        setImageError(false);
                      }}
                      className="btn-primary"
                      style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem' }}
                    >
                      <span>Switch to Snapshot Mode</span>
                    </button>

                    <button
                      onClick={() => {
                        setImageError(false);
                        setPreviewKey(Date.now());
                      }}
                      className="btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem' }}
                    >
                      <RefreshCw size={13} />
                      <span>Retry MJPEG</span>
                    </button>

                    <button
                      onClick={() => setActiveTab('camera')}
                      className="btn-secondary"
                      style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem' }}
                    >
                      <ExternalLink size={13} />
                      <span>Configure Camera</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Viewport Sub-bar */}
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'space-between', 
              marginTop: '0.85rem',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--border-subtle)',
              fontSize: '0.75rem',
              color: 'var(--text-secondary)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontFamily: 'var(--font-mono)' }}>Delivery Mode:</span>
                <button
                  onClick={() => {
                    setStreamMode('proxy');
                    setImageError(false);
                  }}
                  className={`btn-pager ${streamMode === 'proxy' ? 'active' : ''}`}
                  style={{
                    padding: '0.2rem 0.6rem',
                    fontSize: '0.7rem',
                    background: streamMode === 'proxy' ? 'rgba(239, 68, 68, 0.2)' : 'transparent',
                    borderColor: streamMode === 'proxy' ? '#ef4444' : 'var(--border-subtle)'
                  }}
                >
                  MJPEG Proxy
                </button>
                <button
                  onClick={() => {
                    setStreamMode('ai_hud');
                    setImageError(false);
                  }}
                  className={`btn-pager ${streamMode === 'ai_hud' ? 'active' : ''}`}
                  style={{
                    padding: '0.2rem 0.6rem',
                    fontSize: '0.7rem',
                    background: streamMode === 'ai_hud' ? 'rgba(59, 130, 246, 0.25)' : 'transparent',
                    borderColor: streamMode === 'ai_hud' ? '#3b82f6' : 'var(--border-subtle)',
                    color: streamMode === 'ai_hud' ? '#60a5fa' : 'inherit'
                  }}
                >
                  AI Vision HUD
                </button>
                <button
                  onClick={() => {
                    setStreamMode('snapshot_refresh');
                    setImageError(false);
                  }}
                  className={`btn-pager ${streamMode === 'snapshot_refresh' ? 'active' : ''}`}
                  style={{
                    padding: '0.2rem 0.6rem',
                    fontSize: '0.7rem',
                    background: streamMode === 'snapshot_refresh' ? 'rgba(16, 185, 129, 0.2)' : 'transparent',
                    borderColor: streamMode === 'snapshot_refresh' ? '#10b981' : 'var(--border-subtle)'
                  }}
                >
                  Snapshot Refresh
                </button>
              </div>

              <button
                onClick={() => setActiveTab('camera')}
                className="btn-pager"
                style={{ padding: '0.2rem 0.6rem', fontSize: '0.7rem' }}
              >
                <span>Full Camera Settings</span>
                <ArrowRight size={11} />
              </button>
            </div>
          </div>

          {/* Infrastructure Health Status Pill Row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            
            {/* SQLite Health Tile */}
            <div className="pyro-card" style={{ padding: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Database size={16} color="#38bdf8" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>SQLite Database</span>
                </div>
                <span className={`status-pill-badge ${dbStatus?.status === 'ONLINE' ? 'online' : 'offline'}`} style={{ fontSize: '0.65rem' }}>
                  {dbStatus?.status || 'LOCAL'}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>
                {dbStatus?.counts?.sensor_readings ?? 0}
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginLeft: '0.4rem', fontWeight: 400 }}>
                  persisted readings
                </span>
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                WAL Journal • {dbStatus?.file_size_kb ?? 0} KB • {dbStatus?.counts?.alarm_events_active ?? 0} active alarms
              </div>
            </div>

            {/* Cloud Sync Health Tile */}
            <div className="pyro-card" style={{ padding: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Cloud size={16} color="#a855f7" />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>Supabase Cloud</span>
                </div>
                <span className={`status-pill-badge ${cloudStatus?.status === 'SYNCED' || cloudStatus?.status === 'ONLINE_IDLE' ? 'online' : !cloudStatus?.cloud_configured ? 'offline' : 'connecting'}`} style={{ fontSize: '0.65rem' }}>
                  {!cloudStatus?.cloud_configured ? 'LOCAL ONLY' : (cloudStatus?.status || 'DISCONNECTED')}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>
                {cloudStatus?.pending_records ?? 0}
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginLeft: '0.4rem', fontWeight: 400 }}>
                  pending in sync queue
                </span>
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                Interval: 30s • {cloudStatus?.internet_available ? 'Internet Available' : 'Offline Buffer Active'}
              </div>
            </div>

          </div>

        </div>

        {/* Right Column: Real-Time Telemetry & Active Alarms */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          
          {/* Telemetry Freshness & Node Status Banner */}
          <div className="pyro-card" style={{ padding: '1rem 1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <Cpu size={18} color="#34d399" />
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <strong style={{ fontSize: '0.875rem', color: '#0f172a' }}>Sensor Node: {latest?.device_id || 'PYRO-ESP32'}</strong>
                    <span className={`cockpit-freshness-badge ${freshness.state}`}>
                      <span className={`status-indicator-dot ${freshness.state === 'live' ? 'online' : freshness.state === 'stale' ? 'connecting' : 'offline'}`} />
                      <span>{freshness.label}</span>
                    </span>
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                    Transport: {sensorData?.port || 'Hardware Serial'} ({sensorData?.baud_rate || 115200} baud) • Freshness: {freshness.detail}
                  </span>
                </div>
              </div>

              <button
                onClick={() => setActiveTab('settings')}
                className="btn-pager"
                style={{ padding: '0.3rem 0.65rem', fontSize: '0.7rem' }}
              >
                <span>Connection Settings</span>
                <ArrowRight size={11} />
              </button>
            </div>
          </div>

          {/* 4 Primary Safety Gauges (Never show 0 for missing data!) */}
          <div className="cockpit-telemetry-grid">
            
            {/* 1. Temperature Gauge */}
            <div className="cockpit-gauge-card">
              <div className="cockpit-gauge-header">
                <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Thermometer size={14} color="#f97316" />
                  <span>Ambient Temperature</span>
                </span>
                <span style={{
                  fontSize: '0.65rem',
                  fontFamily: 'var(--font-mono)',
                  color: hasTelemetry ? (latest.temperature_c > 45 ? '#ef4444' : latest.temperature_c > 35 ? '#fbbf24' : '#34d399') : '#94a3b8'
                }}>
                  {hasTelemetry ? (latest.temperature_c > 45 ? 'CRITICAL HIGH' : latest.temperature_c > 35 ? 'ELEVATED' : 'NOMINAL') : 'UNAVAILABLE'}
                </span>
              </div>

              <div style={{ margin: '0.5rem 0' }}>
                <span className="cockpit-gauge-val" style={{
                  color: hasTelemetry ? (latest.temperature_c > 45 ? '#ef4444' : latest.temperature_c > 35 ? '#d97706' : '#0f172a') : '#94a3b8'
                }}>
                  {hasTelemetry ? latest.temperature_c.toFixed(1) : 'N/A'}
                </span>
                {hasTelemetry && <span className="cockpit-gauge-unit">°C</span>}
              </div>

              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)', paddingTop: '0.5rem' }}>
                {hasTelemetry ? `DHT22 Calibration: ±0.5°C • Limit: 50.0°C` : 'Sensor disconnected or awaiting packet'}
              </div>
            </div>

            {/* 2. Humidity Gauge */}
            <div className="cockpit-gauge-card">
              <div className="cockpit-gauge-header">
                <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Droplets size={14} color="#38bdf8" />
                  <span>Relative Humidity</span>
                </span>
                <span style={{
                  fontSize: '0.65rem',
                  fontFamily: 'var(--font-mono)',
                  color: hasTelemetry ? '#38bdf8' : '#94a3b8'
                }}>
                  {hasTelemetry ? 'NORMAL' : 'UNAVAILABLE'}
                </span>
              </div>

              <div style={{ margin: '0.5rem 0' }}>
                <span className="cockpit-gauge-val" style={{ color: hasTelemetry ? '#0f172a' : '#94a3b8' }}>
                  {hasTelemetry ? latest.humidity_pct.toFixed(1) : 'N/A'}
                </span>
                {hasTelemetry && <span className="cockpit-gauge-unit">%</span>}
              </div>

              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)', paddingTop: '0.5rem' }}>
                {hasTelemetry ? `DHT22 Calibration: ±2% • Safe Span: 20-90%` : 'Sensor disconnected or awaiting packet'}
              </div>
            </div>

            {/* 3. Flame Hazard Status Gauge */}
            <div className="cockpit-gauge-card" style={{
              border: latest?.flame_detected ? '2px solid #ef4444' : '1px solid var(--border-subtle)',
              background: latest?.flame_detected ? 'rgba(239, 68, 68, 0.12)' : 'var(--bg-card)'
            }}>
              <div className="cockpit-gauge-header">
                <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <Flame size={14} color={latest?.flame_detected ? '#ef4444' : '#10b981'} />
                  <span>Optical Flame Sensor</span>
                </span>
                <span style={{
                  fontSize: '0.65rem',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 700,
                  color: !hasTelemetry ? '#94a3b8' : latest?.flame_detected ? '#ef4444' : '#10b981'
                }}>
                  {!hasTelemetry ? 'NO DATA' : latest?.flame_detected ? 'HAZARD ACTIVE' : 'ALL CLEAR'}
                </span>
              </div>

              <div style={{ margin: '0.5rem 0' }}>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '1.25rem',
                  fontWeight: 800,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  color: !hasTelemetry ? '#94a3b8' : latest?.flame_detected ? '#ef4444' : '#34d399'
                }}>
                  {latest?.flame_detected ? (
                    <>
                      <Flame size={24} className="animate-bounce" />
                      <span>FLAME DETECTED</span>
                    </>
                  ) : hasTelemetry ? (
                    <>
                      <ShieldCheck size={22} color="#34d399" />
                      <span>SAFE (NO FLAME)</span>
                    </>
                  ) : (
                    <span>DISCONNECTED</span>
                  )}
                </div>
              </div>

              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)', paddingTop: '0.5rem' }}>
                {hasTelemetry ? 'Infrared receiver GPIO trigger on node' : 'Real-time flame state unconfirmed'}
              </div>
            </div>

            {/* 4. Local Buzzer Status Gauge */}
            <div className="cockpit-gauge-card" style={{
              border: latest?.buzzer_on ? '2px solid #f59e0b' : '1px solid var(--border-subtle)',
              background: latest?.buzzer_on ? 'rgba(245, 158, 11, 0.12)' : 'var(--bg-card)'
            }}>
              <div className="cockpit-gauge-header">
                <span className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  {latest?.buzzer_on ? <Volume2 size={14} color="#f59e0b" /> : <VolumeX size={14} color="#94a3b8" />}
                  <span>Local Hardware Buzzer</span>
                </span>
                <span style={{
                  fontSize: '0.65rem',
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 700,
                  color: !hasTelemetry ? '#94a3b8' : latest?.buzzer_on ? '#f59e0b' : '#34d399'
                }}>
                  {!hasTelemetry ? 'NO DATA' : latest?.buzzer_on ? 'SOUNDING' : 'STANDBY'}
                </span>
              </div>

              <div style={{ margin: '0.5rem 0' }}>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '1.25rem',
                  fontWeight: 800,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  color: !hasTelemetry ? '#94a3b8' : latest?.buzzer_on ? '#fbbf24' : '#34d399'
                }}>
                  {latest?.buzzer_on ? (
                    <>
                      <Volume2 size={24} className="animate-pulse" />
                      <span>BUZZER ACTIVE</span>
                    </>
                  ) : hasTelemetry ? (
                    <>
                      <VolumeX size={22} color="#34d399" />
                      <span>SILENT (NORMAL)</span>
                    </>
                  ) : (
                    <span>DISCONNECTED</span>
                  )}
                </div>
              </div>

              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)', paddingTop: '0.5rem' }}>
                Autonomous local hardware buzzer on ESP32 GPIO
              </div>
            </div>

          </div>

          {/* Active Alarms & Incident Management Card */}
          <div className="pyro-card" style={{ padding: '1.25rem' }}>
            <div className="card-header" style={{ marginBottom: '0.75rem' }}>
              <div className="card-header-title">
                <ShieldAlert size={18} color={activeAlarms.length > 0 ? '#ef4444' : '#10b981'} />
                <span>Active Safety Alarms & Hazard Incidents</span>
                <span className={`status-pill-badge ${activeAlarms.length > 0 ? 'error' : 'online'}`} style={{ fontSize: '0.7rem' }}>
                  {activeAlarms.length} Active
                </span>
              </div>

              <button
                onClick={fetchActiveAlarms}
                disabled={isLoadingAlarms}
                className="btn-secondary"
                style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem' }}
                title="Refresh Alarms"
              >
                <RefreshCw size={13} className={isLoadingAlarms ? 'animate-spin' : ''} />
                <span>Refresh</span>
              </button>
            </div>

            {/* Alarm List or All-Clear State */}
            {activeAlarms.length === 0 ? (
              <div style={{
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                borderRadius: '8px',
                padding: '1.5rem',
                display: 'flex',
                alignItems: 'center',
                gap: '1rem'
              }}>
                <div style={{ padding: '0.65rem', borderRadius: '50%', background: 'rgba(16, 185, 129, 0.15)', color: '#34d399' }}>
                  <ShieldCheck size={28} />
                </div>
                <div>
                  <h4 style={{ fontSize: '0.925rem', fontWeight: 700, color: '#0f172a' }}>All Safety Protocols Clear</h4>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
                    Zero active unacknowledged flame or environmental hazard incidents currently registered in SQLite local storage.
                  </p>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {activeAlarms.map((alarm) => (
                  <div
                    key={alarm.event_id}
                    style={{
                      background: 'rgba(239, 68, 68, 0.12)',
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      borderRadius: '8px',
                      padding: '0.85rem 1rem',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: '0.75rem'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
                      <div style={{
                        padding: '0.5rem',
                        borderRadius: '6px',
                        background: '#ef4444',
                        color: '#ffffff'
                      }}>
                        <Flame size={18} />
                      </div>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <strong style={{ fontSize: '0.85rem', color: '#b91c1c', fontFamily: 'var(--font-mono)' }}>
                            {alarm.event_type}
                          </strong>
                          <span style={{
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '0.15rem 0.45rem',
                            borderRadius: '4px',
                            background: '#ef4444',
                            color: '#ffffff',
                            fontFamily: 'var(--font-mono)'
                          }}>
                            {alarm.severity}
                          </span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            ID: {alarm.event_id.slice(0, 8)}...
                          </span>
                        </div>
                        <div style={{ fontSize: '0.725rem', color: '#fca5a5', marginTop: '0.2rem' }}>
                          Started: {new Date(alarm.start_time_utc).toLocaleTimeString()} ({new Date(alarm.start_time_utc).toLocaleDateString()}) • Device: {alarm.device_id}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <button
                        onClick={() => handleQuickAck(alarm.event_id)}
                        disabled={acknowledgingId === alarm.event_id}
                        className="btn-danger-outline"
                        style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
                      >
                        <CheckCircle2 size={13} />
                        <span>{acknowledgingId === alarm.event_id ? 'Acknowledging...' : 'Acknowledge'}</span>
                      </button>

                      <button
                        onClick={() => setActiveTab('history')}
                        className="btn-pager"
                        style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem' }}
                      >
                        <span>Audit Log</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

      </div>

      {/* Quick Navigation Footer Strip */}
      <div className="pyro-card" style={{ padding: '1rem 1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            <Layers size={15} color="#38bdf8" />
            <strong style={{ color: '#0f172a' }}>Detailed Operations Panels:</strong>
            <span>Jump directly to dedicated hardware, telemetry audit, or cloud controls.</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              onClick={() => setActiveTab('settings')}
              className="btn-pager"
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
            >
              <Cpu size={13} />
              <span>Device Connections</span>
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className="btn-pager"
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
            >
              <Database size={13} />
              <span>Telemetry & Alarms</span>
            </button>

            <button
              onClick={() => setActiveTab('cloud')}
              className="btn-pager"
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
            >
              <Cloud size={13} />
              <span>Cloud Backup</span>
            </button>

            <button
              onClick={() => setActiveTab('camera')}
              className="btn-pager"
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
            >
              <Video size={13} />
              <span>Camera Feeds</span>
            </button>

            <button
              onClick={() => setActiveTab('diagnostics')}
              className="btn-pager"
              style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
            >
              <Wifi size={13} />
              <span>Network & Audit</span>
            </button>
          </div>
        </div>
      </div>

      {/* Phase 5A: AI-Powered PPE Monitoring & Worker Tracking Cockpit */}
      <PPEComplianceCockpit 
        onSelectStreamMode={setStreamMode}
        currentStreamMode={streamMode}
      />

    </div>
  );
}
