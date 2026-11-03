import React, { useState, useEffect, useRef } from 'react';
import { 
  Video, 
  Save, 
  RotateCcw, 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  ExternalLink, 
  Info, 
  Activity, 
  RefreshCw,
  Eye,
  Sliders,
  Globe,
  Camera
} from 'lucide-react';

const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

export default function CameraSettingsPanel({ onCameraStatusChange }) {
  // Config state
  const [cameraIp, setCameraIp] = useState('10.131.84.41');
  const [streamUrl, setStreamUrl] = useState('http://10.131.84.41:81/stream');
  const [streamMode, setStreamMode] = useState('proxy'); // 'proxy', 'snapshot_refresh', or 'direct'
  
  // Validation & status state
  const [validationError, setValidationError] = useState('');
  const [cameraStatus, setCameraStatus] = useState('Offline');
  const [isTesting, setIsTesting] = useState(false);
  const [testDiagnostics, setTestDiagnostics] = useState(null);
  const [savedSuccessMsg, setSavedSuccessMsg] = useState('');

  // Image stream state
  const [imageError, setImageError] = useState(false);
  const [previewKey, setPreviewKey] = useState(Date.now());
  const [snapshotSrc, setSnapshotSrc] = useState('/api/camera/capture');
  const snapshotTimerRef = useRef(null);
  const retryTimerRef = useRef(null);
  const imgRef = useRef(null);

  // Clean up retry timer and abort browser stream socket on unmount
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

  const handleStreamError = () => {
    setImageError(true);
    if (cameraStatus !== 'Online') {
      setCameraStatus('Offline');
    }
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => {
      setImageError(false);
      setPreviewKey(Date.now());
    }, 2000);
  };

  // Load persisted settings and probe status on mount
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(cfg => {
        if (cfg) {
          if (cfg.camera_ip) setCameraIp(cfg.camera_ip);
          if (cfg.camera_stream_url) setStreamUrl(cfg.camera_stream_url);
          if (cfg.camera_stream_mode) setStreamMode(cfg.camera_stream_mode);
        }
      })
      .catch(() => {
        const savedIp = localStorage.getItem('pyroguard_cam_ip');
        const savedUrl = localStorage.getItem('pyroguard_cam_stream_url');
        const savedMode = localStorage.getItem('pyroguard_cam_stream_mode');
        if (savedIp) setCameraIp(savedIp);
        if (savedUrl) setStreamUrl(savedUrl);
        if (savedMode) setStreamMode(savedMode);
      });

    // Probe status immediately
    fetch('/api/camera/status')
      .then(res => res.json())
      .then(data => {
        if (data?.status) {
          setCameraStatus(data.status);
          if (onCameraStatusChange) onCameraStatusChange(data.status);
        }
      })
      .catch(() => {});
  }, [onCameraStatusChange]);

  // Handle Snapshot Refresh Mode timer (continuous frame polling at ~8 FPS)
  useEffect(() => {
    if (streamMode === 'snapshot_refresh') {
      const interval = setInterval(() => {
        setSnapshotSrc(`/api/camera/capture?t=${Date.now()}`);
      }, 125);
      snapshotTimerRef.current = interval;
      return () => clearInterval(interval);
    } else {
      if (snapshotTimerRef.current) {
        clearInterval(snapshotTimerRef.current);
      }
    }
  }, [streamMode]);

  const handleIpChange = (newIp) => {
    setCameraIp(newIp);
    setValidationError('');
    setSavedSuccessMsg('');

    // Ensure port 81 and /stream are kept in sync
    setStreamUrl(`http://${newIp.trim()}:81/stream`);
  };

  const validateInputs = () => {
    const trimmedIp = cameraIp.trim();
    if (!trimmedIp) {
      setValidationError('Camera IP address cannot be empty.');
      return false;
    }
    if (!IPV4_REGEX.test(trimmedIp)) {
      setValidationError('Invalid IPv4 address format. Example: 10.131.84.41');
      setCameraStatus('Invalid Configuration');
      if (onCameraStatusChange) onCameraStatusChange('Invalid Configuration');
      return false;
    }
    if (streamUrl.trim()) {
      try {
        new URL(streamUrl.trim());
      } catch (e) {
        setValidationError('Invalid Stream URL format. Must include http:// protocol.');
        setCameraStatus('Invalid Configuration');
        if (onCameraStatusChange) onCameraStatusChange('Invalid Configuration');
        return false;
      }
    }
    setValidationError('');
    return true;
  };

  const handleSave = async () => {
    if (!validateInputs()) return;

    localStorage.setItem('pyroguard_cam_ip', cameraIp.trim());
    localStorage.setItem('pyroguard_cam_stream_url', streamUrl.trim());
    localStorage.setItem('pyroguard_cam_stream_mode', streamMode);

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera_ip: cameraIp.trim(),
          camera_stream_url: streamUrl.trim(),
          camera_stream_mode: streamMode
        })
      });
      if (res.ok) {
        setSavedSuccessMsg('Camera configuration saved and persisted across restarts.');
        setTimeout(() => setSavedSuccessMsg(''), 4000);
      }
    } catch (e) {
      setSavedSuccessMsg('Saved to local storage.');
    }

    setPreviewKey(prev => prev + 1);
    setImageError(false);
  };

  const handleTestConnection = async () => {
    if (!validateInputs()) return;

    setIsTesting(true);
    setCameraStatus('Connecting');
    if (onCameraStatusChange) onCameraStatusChange('Connecting');
    setTestDiagnostics(null);

    try {
      const res = await fetch('/api/camera/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          camera_ip: cameraIp.trim(),
          stream_url: streamUrl.trim()
        })
      });

      const data = await res.json();
      setTestDiagnostics(data);
      const newStatus = data.status || (data.is_online ? 'Online' : 'Offline');
      setCameraStatus(newStatus);
      if (onCameraStatusChange) onCameraStatusChange(newStatus);
      if (data.is_online || data.video_stream?.is_online || data.snapshot_capture?.is_online) {
        setImageError(false);
        setPreviewKey(prev => prev + 1);
      }
    } catch (err) {
      setCameraStatus('Offline');
      if (onCameraStatusChange) onCameraStatusChange('Offline');
      setTestDiagnostics({
        is_online: false,
        status: 'Offline',
        details: `Backend test failed: ${err.message}`,
        suggestions: ['Ensure local backend server is running on port 8000.']
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleReset = async () => {
    const defaultIp = '10.131.84.41';
    const defaultUrl = 'http://10.131.84.41:81/stream';
    const defaultMode = 'proxy';

    setCameraIp(defaultIp);
    setStreamUrl(defaultUrl);
    setStreamMode(defaultMode);
    setValidationError('');
    setTestDiagnostics(null);
    setCameraStatus('Offline');
    if (onCameraStatusChange) onCameraStatusChange('Offline');

    localStorage.removeItem('pyroguard_cam_ip');
    localStorage.removeItem('pyroguard_cam_stream_url');
    localStorage.removeItem('pyroguard_cam_stream_mode');

    try {
      await fetch('/api/config/reset', { method: 'POST' });
    } catch (e) {}

    setSavedSuccessMsg('Settings reset to firmware defaults.');
    setTimeout(() => setSavedSuccessMsg(''), 3000);
    setPreviewKey(prev => prev + 1);
  };

  // Determine active preview src
  const activeStreamSrc = streamMode === 'snapshot_refresh'
    ? snapshotSrc
    : streamMode === 'proxy'
    ? `/api/camera/stream?client=camera_tab&t=${previewKey}`
    : `${streamUrl}?t=${previewKey}`;

  const getStatusBadgeClass = () => {
    if (cameraStatus === 'Online') return 'status-pill-badge online';
    if (cameraStatus === 'Connecting') return 'status-pill-badge connecting';
    if (cameraStatus.includes('Busy') || cameraStatus.includes('Limit')) return 'status-pill-badge connecting';
    if (cameraStatus === 'Invalid Configuration' || cameraStatus === 'Invalid Stream Endpoint') return 'status-pill-badge error';
    return 'status-pill-badge offline';
  };

  const getDotClass = () => {
    if (cameraStatus === 'Online') return 'status-indicator-dot online';
    if (cameraStatus === 'Connecting') return 'status-indicator-dot connecting';
    if (cameraStatus.includes('Busy')) return 'status-indicator-dot connecting';
    if (cameraStatus === 'Invalid Configuration' || cameraStatus === 'Invalid Stream Endpoint') return 'status-indicator-dot error';
    return 'status-indicator-dot offline';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Educational Note & Multi-Client Clarification */}
      <div className="arch-banner" style={{ borderLeftColor: '#f59e0b', background: 'rgba(245, 158, 11, 0.05)' }}>
        <div className="arch-info" style={{ maxWidth: '100%' }}>
          <div className="arch-title-box">
            <Info size={18} color="#f59e0b" />
            <h3 className="arch-title" style={{ color: '#fbbf24' }}>
              ESP32-CAM Endpoint & Single-Client Streaming Architecture
            </h3>
          </div>
          <p className="arch-desc">
            The ESP32-CAM serves its web control interface on port 80 (<code style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>http://{cameraIp}/</code>) and its live MJPEG video stream on port 81 (<code style={{ color: '#ef4444', fontFamily: 'var(--font-mono)' }}>http://{cameraIp}:81/stream</code>). 
          </p>
          <span style={{ fontSize: '0.75rem', color: '#fcd34d', display: 'block', marginTop: '0.35rem' }}>
            ⚠ <strong>Important Hardware Note:</strong> The ESP32-CAM microcontroller hardware supports only <strong>ONE</strong> active MJPEG client on port 81 at a time. If another browser tab is currently viewing video at <code style={{ fontFamily: 'var(--font-mono)' }}>http://{cameraIp}/</code>, port 81 will be locked. To view simultaneously, use <strong>Snapshot Refresh</strong> mode below!
          </span>
        </div>
      </div>

      <div className="dashboard-grid">
        {/* Left Column: Form & Connection Controls */}
        <div className="pyro-card">
          <div className="card-header">
            <div className="card-header-title">
              <Sliders size={18} color="#ef4444" />
              <span>Manual Camera IP & Stream Configuration</span>
            </div>

            <div className={getStatusBadgeClass()}>
              <span className={getDotClass()} />
              <span>{cameraStatus}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Manual Camera IPv4 Field */}
            <div className="form-group">
              <label className="form-label">
                <span>ESP32-CAM Local IPv4 Address</span>
                <span className="form-label-hint">Current IP: 10.131.84.41</span>
              </label>
              <input
                type="text"
                value={cameraIp}
                onChange={(e) => handleIpChange(e.target.value)}
                placeholder="10.131.84.41"
                className="pyro-input"
              />
            </div>

            {/* Complete Stream URL Field */}
            <div className="form-group">
              <label className="form-label">
                <span>Actual Video Stream Endpoint URL</span>
                <span className="form-label-hint">Port 81 Stream</span>
              </label>
              <input
                type="text"
                value={streamUrl}
                onChange={(e) => {
                  setStreamUrl(e.target.value);
                  setValidationError('');
                }}
                placeholder="http://10.131.84.41:81/stream"
                className="pyro-input"
              />
              <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)' }}>
                Target must be the MJPEG video stream: <code style={{ color: '#f87171', fontFamily: 'var(--font-mono)' }}>http://{cameraIp}:81/stream</code>, not the HTML web page on port 80.
              </span>
            </div>

            {/* Stream Delivery Mode */}
            <div className="form-group">
              <label className="form-label">
                <span>Stream Delivery Mode</span>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <button
                  type="button"
                  onClick={() => setStreamMode('proxy')}
                  className="pyro-card"
                  style={{
                    padding: '0.85rem',
                    cursor: 'pointer',
                    textAlign: 'left',
                    border: streamMode === 'proxy' ? '1px solid #0284c7' : '1px solid var(--border-subtle)',
                    background: streamMode === 'proxy' ? 'rgba(2, 132, 199, 0.08)' : 'var(--bg-main)'
                  }}
                >
                  <strong style={{ fontSize: '0.8125rem', color: 'var(--text-primary)', display: 'block' }}>MJPEG Proxy (Port 81)</strong>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block', marginTop: '0.2rem' }}>
                    Non-buffering stream proxy. Single-client standard.
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setStreamMode('snapshot_refresh')}
                  className="pyro-card"
                  style={{
                    padding: '0.85rem',
                    cursor: 'pointer',
                    textAlign: 'left',
                    border: streamMode === 'snapshot_refresh' ? '1px solid #059669' : '1px solid var(--border-subtle)',
                    background: streamMode === 'snapshot_refresh' ? 'rgba(5, 150, 105, 0.08)' : 'var(--bg-main)'
                  }}
                >
                  <strong style={{ fontSize: '0.8125rem', color: '#059669', display: 'block' }}>Snapshot Refresh (Port 80)</strong>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'block', marginTop: '0.2rem' }}>
                    High-speed JPEG poll. Works concurrently with other tabs!
                  </span>
                </button>
              </div>
            </div>

            {/* Validation Message */}
            {validationError && (
              <div className="diagnostic-box danger">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <AlertTriangle size={15} />
                  <span>{validationError}</span>
                </div>
              </div>
            )}

            {/* Success Message */}
            {savedSuccessMsg && (
              <div className="diagnostic-box success">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <CheckCircle2 size={15} />
                  <span>{savedSuccessMsg}</span>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '0.75rem', paddingTop: '0.5rem' }}>
              <button
                onClick={handleSave}
                className="btn-primary"
                style={{ flex: 1 }}
              >
                <Save size={16} />
                <span>Save Settings</span>
              </button>

              <button
                onClick={handleTestConnection}
                disabled={isTesting}
                className="btn-secondary"
                style={{ flex: 1 }}
              >
                <Activity size={16} className={isTesting ? 'animate-spin' : ''} />
                <span>{isTesting ? 'Testing Diagnostics...' : 'Test Connection'}</span>
              </button>

              <button
                onClick={handleReset}
                className="btn-secondary"
                style={{ padding: '0.75rem 1rem' }}
                title="Reset to 10.131.84.41:81/stream"
              >
                <RotateCcw size={16} />
              </button>
            </div>
          </div>

          {/* Separated Health Diagnostics Card */}
          {testDiagnostics && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', marginTop: '0.5rem' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.725rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                Independent Diagnostic Verification
              </span>

              {/* 1. Web Interface Check */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0.75rem', borderRadius: '8px', background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', fontSize: '0.75rem' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-primary)' }}>
                  <Globe size={14} color="#0284c7" />
                  <span>Web Control (Port 80):</span>
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', color: testDiagnostics.web_interface?.is_online ? '#059669' : '#ef4444' }}>
                  {testDiagnostics.web_interface?.is_online 
                    ? `✓ Online (${testDiagnostics.web_interface?.latency_ms} ms)` 
                    : '✗ Offline'}
                </span>
              </div>

              {/* 2. Video Stream Check */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0.75rem', borderRadius: '8px', background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', fontSize: '0.75rem' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-primary)' }}>
                  <Video size={14} color="#f97316" />
                  <span>MJPEG Stream (Port 81):</span>
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', color: testDiagnostics.video_stream?.is_online ? '#059669' : '#d97706' }}>
                  {testDiagnostics.video_stream?.is_online 
                    ? `✓ Active Stream (${testDiagnostics.video_stream?.latency_ms} ms)` 
                    : testDiagnostics.video_stream?.details?.includes('busy')
                    ? '⚠ Busy (1-Client Limit)'
                    : '✗ Inactive'}
                </span>
              </div>

              {/* 3. Snapshot Capture Check */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0.75rem', borderRadius: '8px', background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', fontSize: '0.75rem' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-primary)' }}>
                  <Camera size={14} color="#059669" />
                  <span>Still Capture (/capture):</span>
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', color: testDiagnostics.snapshot_capture?.is_online ? '#059669' : '#ef4444' }}>
                  {testDiagnostics.snapshot_capture?.is_online ? `✓ Ready (${testDiagnostics.snapshot_capture?.latency_ms} ms)` : '✗ Offline'}
                </span>
              </div>

              {/* Detailed Diagnostic Suggestions */}
              {testDiagnostics.suggestions && testDiagnostics.suggestions.length > 0 && (
                <div className="diagnostic-box warning" style={{ marginTop: '0.25rem' }}>
                  <strong>Diagnostic Recommendation:</strong>
                  <ul style={{ paddingLeft: '1.25rem', fontSize: '0.725rem', lineHeight: 1.5 }}>
                    {testDiagnostics.suggestions.map((s, idx) => (
                      <li key={idx}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Live Stream Preview Screen */}
        <div className="pyro-card">
          <div className="card-header">
            <div className="card-header-title">
              <Eye size={18} color="#ef4444" />
              <span>Live ESP32-CAM Stream Preview</span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={handleReload}
                className="btn-secondary"
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
                title="Reload Stream"
              >
                <RefreshCw size={13} />
                <span>Reload</span>
              </button>
            </div>
          </div>

          {/* Video Screen Container */}
          <div className="camera-preview-wrapper">
            {!imageError ? (
              <img
                ref={imgRef}
                key={previewKey}
                src={activeStreamSrc}
                alt="ESP32-CAM Live Feed"
                className="camera-video-stream"
                onLoad={() => {
                  setCameraStatus('Online');
                  if (onCameraStatusChange) onCameraStatusChange('Online');
                }}
                onError={handleStreamError}
              />
            ) : null}

            {/* Error / Fallback Screen */}
            {imageError && (
              <div className="camera-fallback-screen">
                <div style={{ padding: '0.75rem', borderRadius: '50%', background: 'rgba(239, 68, 68, 0.1)', color: '#f87171' }}>
                  <Video size={32} opacity={0.7} />
                </div>
                <div>
                  <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff' }}>Video Stream Unavailable</h3>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'block', marginTop: '0.25rem' }}>
                    Unable to stream from <code style={{ color: '#f87171', fontFamily: 'var(--font-mono)' }}>{cameraIp}</code>
                  </span>
                </div>

                <div className="fallback-checklist">
                  <strong>Troubleshooting Diagnostics:</strong>
                  <div>1. Stream endpoint MUST be port 81: <code style={{ color: '#ffffff' }}>http://{cameraIp}:81/stream</code>.</div>
                  <div>2. <strong>One-Client Limit:</strong> If another tab is viewing <code style={{ color: '#ffffff' }}>http://{cameraIp}/</code>, close it or switch to <strong>Snapshot Refresh</strong> mode.</div>
                  <div>3. Web interface is online at <code style={{ color: '#ffffff' }}>http://{cameraIp}/</code>.</div>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    onClick={() => {
                      setStreamMode('snapshot_refresh');
                      setImageError(false);
                    }}
                    className="btn-primary"
                    style={{ fontSize: '0.75rem', padding: '0.45rem 0.85rem' }}
                  >
                    <span>Switch to Snapshot Mode</span>
                  </button>

                  <button
                    onClick={() => {
                      setImageError(false);
                      setPreviewKey(prev => prev + 1);
                    }}
                    className="btn-secondary"
                    style={{ fontSize: '0.75rem', padding: '0.45rem 0.85rem' }}
                  >
                    <RefreshCw size={14} />
                    <span>Retry MJPEG</span>
                  </button>
                  <a
                    href={`http://${cameraIp}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary"
                    style={{ fontSize: '0.75rem', padding: '0.45rem 0.85rem', textDecoration: 'none' }}
                  >
                    <ExternalLink size={14} />
                    <span>Open Web UI</span>
                  </a>
                </div>
              </div>
            )}

            {/* Live HUD Watermark */}
            {!imageError && (
              <div className="camera-hud-badge">
                <span className={`status-indicator-dot ${cameraStatus === 'Online' ? 'online' : cameraStatus === 'Connecting' ? 'connecting' : 'offline'}`} />
                <span>{cameraStatus === 'Online' ? 'LIVE' : cameraStatus.toUpperCase()} | {cameraIp} ({streamMode.toUpperCase()})</span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
            <span>Active Mode: <strong style={{ color: '#34d399' }}>{streamMode}</strong></span>
            <span>Target: <strong style={{ color: '#ffffff' }}>{streamMode === 'proxy' ? '/api/camera/stream' : streamMode === 'snapshot_refresh' ? '/api/camera/capture' : streamUrl}</strong></span>
          </div>
        </div>
      </div>
    </div>
  );
}
