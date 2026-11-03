import React, { useState, useEffect } from 'react';
import { Flame, Cpu, Video, Wifi, Database, Cloud, LayoutDashboard } from 'lucide-react';

export default function Header({ sensorStatus, cameraStatus, dbStatus, cloudStatus, activeTab, setActiveTab }) {
  const [time, setTime] = useState(new Date().toLocaleTimeString());

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const getSensorDotClass = () => {
    if (sensorStatus === 'CONNECTED') return 'status-indicator-dot online';
    if (sensorStatus === 'WAITING FOR DATA' || sensorStatus === 'CONNECTING' || sensorStatus === 'STALE') {
      return 'status-indicator-dot connecting';
    }
    if (sensorStatus === 'ERROR') return 'status-indicator-dot error';
    return 'status-indicator-dot offline';
  };

  const getSensorTextColor = () => {
    if (sensorStatus === 'CONNECTED') return '#059669';
    if (sensorStatus === 'WAITING FOR DATA' || sensorStatus === 'STALE' || sensorStatus === 'CONNECTING') return '#d97706';
    if (sensorStatus === 'ERROR') return '#dc2626';
    return '#64748b';
  };

  const getCameraDotClass = () => {
    if (cameraStatus === 'Online') return 'status-indicator-dot online';
    if (cameraStatus === 'Checking' || cameraStatus === 'Connecting' || cameraStatus.includes('Busy')) return 'status-indicator-dot connecting';
    if (cameraStatus === 'Invalid Configuration' || cameraStatus === 'Invalid Stream Endpoint') return 'status-indicator-dot error';
    return 'status-indicator-dot offline';
  };

  const getDbDotClass = () => {
    if (dbStatus?.status === 'ONLINE') return 'status-indicator-dot online';
    if (dbStatus?.status === 'DEGRADED') return 'status-indicator-dot connecting';
    return 'status-indicator-dot offline';
  };

  const getCloudDotClass = () => {
    if (!cloudStatus?.cloud_configured) return 'status-indicator-dot offline';
    if (!cloudStatus?.internet_available) return 'status-indicator-dot error';
    if (cloudStatus?.status === 'SYNCED' || cloudStatus?.status === 'ONLINE' || cloudStatus?.status === 'ONLINE_IDLE') return 'status-indicator-dot online';
    if (cloudStatus?.status === 'AUTH_FAILURE') return 'status-indicator-dot error';
    return 'status-indicator-dot connecting';
  };

  const getCloudTextColor = () => {
    if (!cloudStatus?.cloud_configured) return '#64748b';
    if (!cloudStatus?.internet_available) return '#dc2626';
    if (cloudStatus?.status === 'SYNCED' || cloudStatus?.status === 'ONLINE' || cloudStatus?.status === 'ONLINE_IDLE') return '#059669';
    if (cloudStatus?.status === 'AUTH_FAILURE') return '#dc2626';
    return '#d97706';
  };

  return (
    <header className="pyro-header">
      <div className="header-content">
        {/* Brand section */}
        <div className="brand-section">
          <div className="brand-icon-box">
            <Flame size={24} color="#ffffff" />
          </div>
          <div className="brand-title-wrap">
            <div className="brand-title">
              <span>PYROGUARD<span className="accent">-H</span></span>
              <span className="brand-badge">SAFETY COMMAND CENTER</span>
            </div>
            <span className="brand-subtitle">
              Industrial Worker Safety & Hazard Telemetry Platform
            </span>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="nav-tab-container">
          <button
            onClick={() => setActiveTab('overview')}
            className={`nav-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
          >
            <LayoutDashboard size={15} />
            <span>Overview</span>
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={`nav-tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          >
            <Cpu size={15} />
            <span>Device Connections</span>
          </button>

          <button
            onClick={() => setActiveTab('history')}
            className={`nav-tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          >
            <Database size={15} />
            <span>Telemetry & Alarms</span>
          </button>

          <button
            onClick={() => setActiveTab('cloud')}
            className={`nav-tab-btn ${activeTab === 'cloud' ? 'active' : ''}`}
          >
            <Cloud size={15} />
            <span>Cloud Backup</span>
          </button>

          <button
            onClick={() => setActiveTab('camera')}
            className={`nav-tab-btn ${activeTab === 'camera' ? 'active' : ''}`}
          >
            <Video size={15} />
            <span>Camera Feeds</span>
          </button>

          <button
            onClick={() => setActiveTab('diagnostics')}
            className={`nav-tab-btn ${activeTab === 'diagnostics' ? 'active' : ''}`}
          >
            <Wifi size={15} />
            <span>Network & Audit</span>
          </button>
        </div>

        {/* Live Status Indicators */}
        <div className="header-status-group">
          <div className="status-pill">
            <span className={getDbDotClass()} />
            <span>DB: <strong style={{ color: dbStatus?.status === 'ONLINE' ? '#059669' : '#64748b' }}>
              {dbStatus?.status === 'ONLINE' ? `WAL (${dbStatus?.counts?.sensor_readings ?? 0})` : (dbStatus?.status || 'LOCAL')}
            </strong></span>
          </div>

          <div className="status-pill">
            <span className={getCloudDotClass()} />
            <span>Cloud: <strong style={{ color: getCloudTextColor() }}>
              {!cloudStatus?.cloud_configured 
                ? 'LOCAL ONLY' 
                : !cloudStatus?.internet_available 
                ? 'OFFLINE' 
                : cloudStatus?.status === 'SYNCED' || cloudStatus?.status === 'ONLINE_IDLE' 
                ? 'SYNCED' 
                : cloudStatus?.status}
            </strong></span>
          </div>

          <div className="status-pill">
            <span className={getSensorDotClass()} />
            <span>Sensor: <strong style={{ color: getSensorTextColor() }}>{sensorStatus}</strong></span>
          </div>

          <div className="status-pill">
            <span className={getCameraDotClass()} />
            <span>CAM: <strong style={{ color: cameraStatus === 'Online' ? '#059669' : cameraStatus === 'Checking' ? '#0284c7' : cameraStatus === 'Offline' ? '#64748b' : '#d97706' }}>{cameraStatus}</strong></span>
          </div>

          <div className="clock-display">
            {time}
          </div>
        </div>
      </div>
    </header>
  );
}
