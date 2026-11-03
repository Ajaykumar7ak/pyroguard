import React, { useState, useEffect, useCallback } from 'react';
import { 
  Database, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle2, 
  Flame, 
  Volume2, 
  Thermometer, 
  Droplets, 
  Clock, 
  ChevronLeft, 
  ChevronRight, 
  Filter, 
  HardDrive, 
  ShieldAlert, 
  Layers, 
  Check, 
  X,
  FileText,
  Camera,
  Eye,
  Maximize2
} from 'lucide-react';
import TelemetryTrendCharts from './TelemetryTrendCharts';

export default function TelemetryHistoryPanel() {
  // Database status state
  const [dbStatus, setDbStatus] = useState(null);
  const [isLoadingDbStatus, setIsLoadingDbStatus] = useState(false);
  const [dbError, setDbError] = useState(null);

  // Alarms state
  const [alarms, setAlarms] = useState([]);
  const [totalAlarms, setTotalAlarms] = useState(0);
  const [activeAlarmsOnly, setActiveAlarmsOnly] = useState(false);
  const [alarmSeverityFilter, setAlarmSeverityFilter] = useState('');
  const [isLoadingAlarms, setIsLoadingAlarms] = useState(false);
  const [acknowledgingId, setAcknowledgingId] = useState(null);
  const [ackNote, setAckNote] = useState('');
  const [showAckModal, setShowAckModal] = useState(false);
  const [selectedAlarmForAck, setSelectedAlarmForAck] = useState(null);

  // Telemetry Readings History state
  const [readings, setReadings] = useState([]);
  const [totalReadings, setTotalReadings] = useState(0);
  const [isLoadingReadings, setIsLoadingReadings] = useState(false);
  const [limit, setLimit] = useState(25);

  // PPE Incidents state
  const [ppeIncidents, setPpeIncidents] = useState([]);
  const [totalPpeIncidents, setTotalPpeIncidents] = useState(0);
  const [ppeStatusFilter, setPpeStatusFilter] = useState('');
  const [isLoadingPpeIncidents, setIsLoadingPpeIncidents] = useState(false);
  const [selectedPpeEvidence, setSelectedPpeEvidence] = useState(null);
  const [showPpeAckModal, setShowPpeAckModal] = useState(false);
  const [selectedPpeForAck, setSelectedPpeForAck] = useState(null);
  const [ppeAckNote, setPpeAckNote] = useState('');
  const [isAckingPpe, setIsAckingPpe] = useState(false);
  const [offset, setOffset] = useState(0);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [deviceIdFilter, setDeviceIdFilter] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Fetch Database Health & Status
  const fetchDbStatus = useCallback(async () => {
    setIsLoadingDbStatus(true);
    setDbError(null);
    try {
      const res = await fetch('/api/database/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch DB status`);
      const data = await res.json();
      setDbStatus(data);
    } catch (err) {
      setDbError(err.message);
    } finally {
      setIsLoadingDbStatus(false);
    }
  }, []);

  // Fetch Alarms
  const fetchAlarms = useCallback(async () => {
    setIsLoadingAlarms(true);
    try {
      const params = new URLSearchParams({
        active_only: activeAlarmsOnly.toString(),
        limit: '50',
        offset: '0'
      });
      if (alarmSeverityFilter) {
        params.append('severity', alarmSeverityFilter);
      }
      const res = await fetch(`/api/alarms?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setAlarms(data.alarms || []);
        setTotalAlarms(data.total || 0);
      }
    } catch (err) {
      console.error('Error fetching alarms:', err);
    } finally {
      setIsLoadingAlarms(false);
    }
  }, [activeAlarmsOnly, alarmSeverityFilter]);

  // Fetch Telemetry History
  const fetchReadings = useCallback(async () => {
    setIsLoadingReadings(true);
    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString()
      });
      if (startTime) params.append('start_time', startTime);
      if (endTime) params.append('end_time', endTime);
      if (deviceIdFilter) params.append('device_id', deviceIdFilter);

      const res = await fetch(`/api/sensor/readings/history?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setReadings(data.readings || []);
        setTotalReadings(data.total || 0);
      }
    } catch (err) {
      console.error('Error fetching sensor history:', err);
    } finally {
      setIsLoadingReadings(false);
    }
  }, [limit, offset, startTime, endTime, deviceIdFilter]);

  // Fetch PPE Incidents
  const fetchPpeIncidents = useCallback(async () => {
    setIsLoadingPpeIncidents(true);
    try {
      const q = ppeStatusFilter ? `&status=${ppeStatusFilter}` : '';
      const res = await fetch(`/api/ppe/incidents?limit=50${q}`);
      if (res.ok) {
        const data = await res.json();
        setPpeIncidents(data.incidents || []);
        setTotalPpeIncidents(data.total || 0);
      }
    } catch (err) {
      console.error('Failed to load PPE incidents:', err);
    } finally {
      setIsLoadingPpeIncidents(false);
    }
  }, [ppeStatusFilter]);

  // Acknowledge PPE Incident
  const handleAcknowledgePpe = async () => {
    if (!selectedPpeForAck) return;
    setIsAckingPpe(true);
    try {
      const res = await fetch(`/api/ppe/incidents/${selectedPpeForAck.incident_id}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: ppeAckNote.trim() || 'Acknowledged by operator in Telemetry History audit.' })
      });
      if (res.ok) {
        setShowPpeAckModal(false);
        setSelectedPpeForAck(null);
        setPpeAckNote('');
        fetchPpeIncidents();
        fetchDbStatus();
      }
    } catch (e) {
      console.error('Failed to acknowledge PPE incident:', e);
    } finally {
      setIsAckingPpe(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchDbStatus();
    fetchAlarms();
    fetchPpeIncidents();
    fetchReadings();
  }, [fetchDbStatus, fetchAlarms, fetchPpeIncidents, fetchReadings]);

  // Auto-refresh timer (every 4 seconds)
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchDbStatus();
      fetchAlarms();
      fetchPpeIncidents();
      fetchReadings();
    }, 4000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchDbStatus, fetchAlarms, fetchPpeIncidents, fetchReadings]);

  // Handle Alarm Acknowledgment
  const handleAcknowledge = async () => {
    if (!selectedAlarmForAck) return;
    setAcknowledgingId(selectedAlarmForAck.event_id);
    try {
      const res = await fetch(`/api/alarms/${selectedAlarmForAck.event_id}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: ackNote.trim() || undefined })
      });
      if (res.ok) {
        setShowAckModal(false);
        setAckNote('');
        setSelectedAlarmForAck(null);
        fetchAlarms();
      } else {
        alert('Failed to acknowledge alarm');
      }
    } catch (err) {
      alert(`Error acknowledging alarm: ${err.message}`);
    } finally {
      setAcknowledgingId(null);
    }
  };

  // Pagination navigation
  const handlePrevPage = () => {
    setOffset(prev => Math.max(0, prev - limit));
  };

  const handleNextPage = () => {
    if (offset + limit < totalReadings) {
      setOffset(prev => prev + limit);
    }
  };

  const handleApplyFilter = (e) => {
    e.preventDefault();
    setOffset(0);
    fetchReadings();
  };

  const handleResetFilter = () => {
    setStartTime('');
    setEndTime('');
    setDeviceIdFilter('');
    setOffset(0);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Database Error Banner */}
      {dbError && (
        <div className="diagnostic-box danger">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
            <AlertTriangle size={16} />
            <span>SQLite Database Communication Error</span>
          </div>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{dbError}</p>
          <span style={{ fontSize: '0.725rem', opacity: 0.85 }}>
            Ensure the local FastAPI backend is running and has write access to the backend directory.
          </span>
        </div>
      )}

      {/* Top Section: Local Database Health & Architecture */}
      <div className="pyro-card">
        <div className="card-header">
          <div className="card-header-title">
            <Database size={18} color="#38bdf8" />
            <span>Local-First SQLite Database Architecture (Offline-Ready)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className={`status-pill-badge ${dbStatus?.status === 'ONLINE' ? 'online' : 'offline'}`}>
              <span className={`status-indicator-dot ${dbStatus?.status === 'ONLINE' ? 'online' : 'offline'}`} />
              <span>{dbStatus?.status || 'INITIALIZING'}</span>
            </div>
            <button
              onClick={() => { fetchDbStatus(); fetchAlarms(); fetchReadings(); }}
              disabled={isLoadingDbStatus}
              className="btn-secondary"
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
              title="Refresh database metadata"
            >
              <RefreshCw size={13} className={isLoadingDbStatus ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        <div className="db-stats-grid">
          <div className="db-stat-tile">
            <span className="db-stat-tile-label">
              <HardDrive size={13} />
              <span>Persisted Readings</span>
            </span>
            <span className="db-stat-tile-val">
              {dbStatus?.counts?.sensor_readings ?? 0}
            </span>
            <span className="db-stat-tile-sub">
              {dbStatus ? `${dbStatus.file_size_kb} KB on disk (WAL Mode)` : 'Reading SQLite table...'}
            </span>
          </div>

          <div className="db-stat-tile">
            <span className="db-stat-tile-label">
              <ShieldAlert size={13} color="#ef4444" />
              <span>Active Hazard Incidents</span>
            </span>
            <span className="db-stat-tile-val" style={{ color: (dbStatus?.counts?.alarm_events_active || 0) > 0 ? '#ef4444' : '#34d399' }}>
              {dbStatus?.counts?.alarm_events_active ?? 0}
            </span>
            <span className="db-stat-tile-sub">
              {dbStatus?.counts?.alarm_events_total ?? 0} total alarms historically logged
            </span>
          </div>

          <div className="db-stat-tile">
            <span className="db-stat-tile-label">
              <Layers size={13} color="#f59e0b" />
              <span>Durable Sync Queue</span>
            </span>
            <span className="db-stat-tile-val" style={{ color: '#fbbf24' }}>
              {dbStatus?.counts?.sync_queue_pending ?? 0}
            </span>
            <span className="db-stat-tile-sub">
              Staged locally for Cloud Backup
            </span>
          </div>

          <div className="db-stat-tile">
            <span className="db-stat-tile-label">
              <Camera size={13} color="#0284c7" />
              <span>AI PPE Violations</span>
            </span>
            <span className="db-stat-tile-val" style={{ color: (dbStatus?.counts?.ppe_incidents_open || 0) > 0 ? '#ef4444' : '#059669' }}>
              {dbStatus?.counts?.ppe_incidents_open ?? 0}
            </span>
            <span className="db-stat-tile-sub">
              {dbStatus?.counts?.ppe_incidents_total ?? 0} total confirmed incidents recorded
            </span>
          </div>

          <div className="db-stat-tile">
            <span className="db-stat-tile-label">
              <CheckCircle2 size={13} color="#10b981" />
              <span>Storage Integrity</span>
            </span>
            <span className="db-stat-tile-val" style={{ fontSize: '1.25rem', color: '#34d399' }}>
              {dbStatus?.integrity === 'OK' ? 'PASSED (OK)' : (dbStatus?.integrity || 'CHECKING')}
            </span>
            <span className="db-stat-tile-sub">
              Zero cloud dependency • 100% Local-First
            </span>
          </div>
        </div>
      </div>

      {/* Middle Section: Active Hazard Incidents & Alarms Table */}
      <div className="pyro-card">
        <div className="card-header">
          <div className="card-header-title">
            <ShieldAlert size={18} color="#ef4444" />
            <span>Hazard Incidents & Alarm Audit Log ({totalAlarms})</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
              <input
                type="checkbox"
                id="activeAlarmsOnly"
                checked={activeAlarmsOnly}
                onChange={(e) => setActiveAlarmsOnly(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: '#ef4444' }}
              />
              <label htmlFor="activeAlarmsOnly" style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>
                Active Incidents Only
              </label>
            </div>

            <select
              value={alarmSeverityFilter}
              onChange={(e) => setAlarmSeverityFilter(e.target.value)}
              className="pyro-input pyro-select"
              style={{ width: 'auto', padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
            >
              <option value="">All Severities</option>
              <option value="CRITICAL">Critical (Flame Hazard)</option>
              <option value="WARNING">Warning (High Temp)</option>
            </select>
          </div>
        </div>

        {alarms.length === 0 ? (
          <div className="empty-state-box">
            <CheckCircle2 size={36} color="#10b981" />
            <strong style={{ color: 'var(--text-primary)' }}>No Recorded Hazard Alarms</strong>
            <p>
              {activeAlarmsOnly 
                ? 'No critical flame or temperature hazard incidents are currently active.' 
                : 'Zero hazard events recorded in the database. When a flame or thermal threshold transition occurs, it will be automatically logged here.'}
            </p>
          </div>
        ) : (
          <div className="pyro-table-container">
            <table className="pyro-table">
              <thead>
                <tr>
                  <th>Event ID</th>
                  <th>Severity</th>
                  <th>Hazard Type</th>
                  <th>Source</th>
                  <th>Start Time (UTC / Local)</th>
                  <th>Status / Resolution</th>
                  <th>Acknowledgment</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {alarms.map((alarm) => {
                  const isCrit = alarm.severity === 'CRITICAL';
                  const isActive = alarm.is_active;

                  return (
                    <tr key={alarm.event_id} className={isActive && isCrit ? 'row-danger' : ''}>
                      <td style={{ color: 'var(--accent-primary)' }} title={alarm.event_id}>
                        {alarm.event_id.slice(0, 8)}...
                      </td>
                      <td>
                        <span className={`table-badge ${isCrit ? 'danger' : 'warning'}`}>
                          {alarm.severity}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                          {alarm.event_type === 'FLAME_HAZARD' && <Flame size={14} color="#ef4444" />}
                          {alarm.event_type === 'HIGH_TEMPERATURE' && <Thermometer size={14} color="#f59e0b" />}
                          <span>{alarm.event_type}</span>
                        </div>
                      </td>
                      <td>
                        <span className="table-badge muted">
                          {alarm.source}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ color: 'var(--text-primary)' }}>{new Date(alarm.start_time_utc).toLocaleTimeString()}</span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            {new Date(alarm.start_time_utc).toLocaleDateString()}
                          </span>
                        </div>
                      </td>
                      <td>
                        {isActive ? (
                          <span className="table-badge danger animate-pulse">
                            ACTIVE HAZARD
                          </span>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="table-badge success">RESOLVED</span>
                            {alarm.end_time_utc && (
                              <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)' }}>
                                {new Date(alarm.end_time_utc).toLocaleTimeString()}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td>
                        {alarm.is_acknowledged ? (
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span className="table-badge success" style={{ background: 'rgba(16, 185, 129, 0.1)' }}>
                              <Check size={11} /> Ack'd
                            </span>
                            {alarm.operator_notes && (
                              <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)', fontStyle: 'italic', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                "{alarm.operator_notes}"
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="table-badge muted">Pending Ack</span>
                        )}
                      </td>
                      <td>
                        {!alarm.is_acknowledged && (
                          <button
                            onClick={() => {
                              setSelectedAlarmForAck(alarm);
                              setAckNote('');
                              setShowAckModal(true);
                            }}
                            className="btn-pager"
                            style={{ padding: '0.25rem 0.6rem', fontSize: '0.7rem' }}
                          >
                            <FileText size={12} />
                            <span>Ack</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Middle Section 2: AI PPE Compliance Incidents & Evidence Audit Log */}
      <div className="pyro-card">
        <div className="card-header">
          <div className="card-header-title">
            <Camera size={18} color="#38bdf8" />
            <span>AI PPE Violation Incidents & Evidence Audit Log ({totalPpeIncidents})</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <select
              value={ppeStatusFilter}
              onChange={(e) => setPpeStatusFilter(e.target.value)}
              className="pyro-input pyro-select"
              style={{ width: 'auto', padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
            >
              <option value="">All Incident States</option>
              <option value="OPEN">Open (Unacknowledged)</option>
              <option value="ACKNOWLEDGED">Acknowledged</option>
              <option value="RESOLVED">Resolved (Compliant)</option>
            </select>
          </div>
        </div>

        {ppeIncidents.length === 0 ? (
          <div className="empty-state-box">
            <CheckCircle2 size={36} color="#10b981" />
            <strong style={{ color: 'var(--text-primary)' }}>No Recorded PPE Incidents</strong>
            <p>
              When a worker maintains a confirmed missing PPE state beyond the safety threshold, an annotated evidence snapshot and incident audit log will automatically be recorded here.
            </p>
          </div>
        ) : (
          <div className="pyro-table-container">
            <table className="pyro-table">
              <thead>
                <tr>
                  <th>Incident ID</th>
                  <th>Worker Track</th>
                  <th>Missing Safety Gear</th>
                  <th>Violation Duration</th>
                  <th>Trigger Time (Local)</th>
                  <th>Status</th>
                  <th>Evidence Snapshot</th>
                  <th>Operator Actions</th>
                </tr>
              </thead>
              <tbody>
                {ppeIncidents.map((inc) => {
                  const isOpen = inc.status === 'OPEN';
                  const isAck = inc.status === 'ACKNOWLEDGED';

                  return (
                    <tr key={inc.incident_id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
                        {inc.incident_id}
                      </td>
                      <td>
                        <span style={{
                          background: 'rgba(59, 130, 246, 0.15)',
                          color: '#60a5fa',
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          fontFamily: 'var(--font-mono)'
                        }}>
                          Worker #{inc.track_id}
                        </span>
                      </td>
                      <td>
                        <span style={{ color: '#f87171', fontWeight: 600 }}>
                          {inc.missing_ppe}
                        </span>
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>
                        {inc.duration_seconds}s sustained
                      </td>
                      <td style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                        {new Date(inc.trigger_time_utc).toLocaleString()}
                      </td>
                      <td>
                        <span style={{
                          fontSize: '0.7rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
                          background: isOpen ? 'rgba(239, 68, 68, 0.2)' : isAck ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                          color: isOpen ? '#f87171' : isAck ? '#fbbf24' : '#34d399'
                        }}>
                          {inc.status}
                        </span>
                      </td>
                      <td>
                        {inc.evidence_image_path ? (
                          <button
                            onClick={() => setSelectedPpeEvidence(inc)}
                            className="btn-pager"
                            style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem' }}
                          >
                            <Eye size={12} />
                            <span>View Snapshot</span>
                          </button>
                        ) : (
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>None</span>
                        )}
                      </td>
                      <td>
                        {isOpen && (
                          <button
                            onClick={() => {
                              setSelectedPpeForAck(inc);
                              setPpeAckNote('');
                              setShowPpeAckModal(true);
                            }}
                            className="btn-pager"
                            style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem' }}
                          >
                            <Check size={12} />
                            <span>Ack</span>
                          </button>
                        )}
                        {inc.operator_notes && (
                          <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)', display: 'block', marginTop: '0.2rem', fontStyle: 'italic' }}>
                            "{inc.operator_notes}"
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Middle Section: Real-Time Historical Trendlines (1h / 24h Pure SVG) */}
      <TelemetryTrendCharts />

      {/* Bottom Section: Telemetry Sensor Readings History Table */}
      <div className="pyro-card">
        <div className="card-header">
          <div className="card-header-title">
            <Clock size={18} color="#10b981" />
            <span>Historical Telemetry Records ({totalReadings} Total)</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', fontFamily: 'var(--font-mono)' }}>
              <input
                type="checkbox"
                id="autoRefresh"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: '#10b981' }}
              />
              <label htmlFor="autoRefresh" style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>
                Live Polling (4s)
              </label>
            </div>

            <button
              onClick={fetchReadings}
              disabled={isLoadingReadings}
              className="btn-secondary"
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
              title="Refresh readings table"
            >
              <RefreshCw size={13} className={isLoadingReadings ? 'animate-spin' : ''} />
              <span>Refresh History</span>
            </button>
          </div>
        </div>

        {/* Filter Toolbar */}
        <form onSubmit={handleApplyFilter} className="filter-bar">
          <div className="filter-item">
            <label>Start Timestamp</label>
            <input
              type="text"
              placeholder="YYYY-MM-DDTHH:MM:SS"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="filter-input"
              style={{ width: '180px' }}
            />
          </div>

          <div className="filter-item">
            <label>End Timestamp</label>
            <input
              type="text"
              placeholder="YYYY-MM-DDTHH:MM:SS"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="filter-input"
              style={{ width: '180px' }}
            />
          </div>

          <div className="filter-item">
            <label>Device ID</label>
            <input
              type="text"
              placeholder="PYRO-ESP32"
              value={deviceIdFilter}
              onChange={(e) => setDeviceIdFilter(e.target.value)}
              className="filter-input"
              style={{ width: '130px' }}
            />
          </div>

          <div className="filter-item">
            <label>Page Size</label>
            <select
              value={limit}
              onChange={(e) => { setLimit(Number(e.target.value)); setOffset(0); }}
              className="filter-input"
              style={{ width: '90px' }}
            >
              <option value={25}>25 / page</option>
              <option value={50}>50 / page</option>
              <option value={100}>100 / page</option>
              <option value={250}>250 / page</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: '0.4rem', marginTop: 'auto' }}>
            <button type="submit" className="btn-primary" style={{ padding: '0.4rem 0.85rem', fontSize: '0.75rem' }}>
              <Filter size={13} />
              <span>Filter</span>
            </button>
            {(startTime || endTime || deviceIdFilter) && (
              <button type="button" onClick={handleResetFilter} className="btn-secondary" style={{ padding: '0.4rem 0.75rem', fontSize: '0.75rem' }}>
                <X size={13} />
                <span>Clear</span>
              </button>
            )}
          </div>
        </form>

        {/* Table Content */}
        {isLoadingReadings && readings.length === 0 ? (
          <div className="empty-state-box">
            <RefreshCw size={28} className="animate-spin" color="#38bdf8" />
            <span>Querying local SQLite database...</span>
          </div>
        ) : readings.length === 0 ? (
          <div className="empty-state-box">
            <Database size={36} color="#64748b" />
            <strong style={{ color: 'var(--text-primary)' }}>No Historical Sensor Records Found</strong>
            <p>
              The SQLite database is connected and ready. As the ESP32 streams sensor telemetry over COM4 / Web Serial, every validated reading will automatically persist here.
            </p>
          </div>
        ) : (
          <div className="pyro-table-container">
            <table className="pyro-table">
              <thead>
                <tr>
                  <th>Timestamp (UTC)</th>
                  <th>Device ID</th>
                  <th>Uptime</th>
                  <th>Temperature</th>
                  <th>Humidity</th>
                  <th>Flame Sensor</th>
                  <th>Physical Buzzer</th>
                  <th>Validation</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {readings.map((r) => {
                  const isFlame = Boolean(r.flame_detected);
                  const isBuzzer = Boolean(r.buzzer_on);
                  const isDegraded = r.validation_status === 'DEGRADED';

                  return (
                    <tr key={r.reading_id} className={isFlame ? 'row-danger' : ''}>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ color: 'var(--text-primary)' }}>{new Date(r.timestamp_utc).toLocaleTimeString()}</span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            {r.timestamp_utc.split('T')[0]}
                          </span>
                        </div>
                      </td>
                      <td style={{ color: '#38bdf8' }}>{r.device_id}</td>
                      <td>
                        {r.uptime_ms !== null && r.uptime_ms !== undefined ? (
                          <span>{(r.uptime_ms / 1000).toFixed(1)}s</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>N/A</span>
                        )}
                      </td>
                      <td>
                        {r.temperature_c !== null && r.temperature_c !== undefined ? (
                          <span style={{ color: r.temperature_c >= 50.0 ? '#ef4444' : '#ffffff', fontWeight: 600 }}>
                            {r.temperature_c} °C
                          </span>
                        ) : (
                          <span style={{ color: '#f59e0b', fontStyle: 'italic' }}>DHT Err</span>
                        )}
                      </td>
                      <td>
                        {r.humidity_pct !== null && r.humidity_pct !== undefined ? (
                          <span>{r.humidity_pct} %</span>
                        ) : (
                          <span style={{ color: '#f59e0b', fontStyle: 'italic' }}>DHT Err</span>
                        )}
                      </td>
                      <td>
                        <span className={`table-badge ${isFlame ? 'danger' : 'success'}`}>
                          {isFlame ? 'FIRE DETECTED' : 'CLEAR'}
                        </span>
                      </td>
                      <td>
                        <span className={`table-badge ${isBuzzer ? 'warning' : 'muted'}`}>
                          {isBuzzer ? 'ACTIVE' : 'SILENT'}
                        </span>
                      </td>
                      <td>
                        <span className={`table-badge ${isDegraded ? 'warning' : 'success'}`}>
                          {r.validation_status}
                        </span>
                      </td>
                      <td>
                        <span className="table-badge muted">
                          {r.source}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination Controls */}
            <div className="pagination-bar">
              <span>
                Showing {Math.min(offset + 1, totalReadings)} - {Math.min(offset + limit, totalReadings)} of {totalReadings} records
              </span>

              <div className="pagination-btn-group">
                <button
                  onClick={handlePrevPage}
                  disabled={offset === 0 || isLoadingReadings}
                  className="btn-pager"
                >
                  <ChevronLeft size={14} />
                  <span>Previous</span>
                </button>

                <span>
                  Page {Math.floor(offset / limit) + 1} of {Math.max(1, Math.ceil(totalReadings / limit))}
                </span>

                <button
                  onClick={handleNextPage}
                  disabled={offset + limit >= totalReadings || isLoadingReadings}
                  className="btn-pager"
                >
                  <span>Next</span>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Operator Acknowledgment Modal */}
      {showAckModal && selectedAlarmForAck && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 999
        }}>
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '12px',
            width: '90%',
            maxWidth: '480px',
            padding: '1.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1.25rem',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>
                <ShieldAlert size={18} color="#ef4444" />
                <span>Acknowledge Hazard Incident</span>
              </div>
              <button onClick={() => setShowAckModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', padding: '0.85rem', borderRadius: '8px', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
              <div><strong>Event ID:</strong> {selectedAlarmForAck.event_id}</div>
              <div><strong>Hazard:</strong> {selectedAlarmForAck.event_type} ({selectedAlarmForAck.severity})</div>
              <div><strong>Started:</strong> {new Date(selectedAlarmForAck.start_time_utc).toLocaleString()}</div>
            </div>

            <div className="form-group">
              <label className="form-label">
                <span>Operator Notes (Optional)</span>
                <span className="form-label-hint">Audit trail record</span>
              </label>
              <textarea
                value={ackNote}
                onChange={(e) => setAckNote(e.target.value)}
                placeholder="e.g. Flame observed in test cell, cleared by supervisor."
                className="pyro-input"
                style={{ height: '80px', resize: 'none' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button onClick={() => setShowAckModal(false)} className="btn-secondary">
                Cancel
              </button>
              <button onClick={handleAcknowledge} disabled={acknowledgingId !== null} className="btn-primary">
                {acknowledgingId ? 'Saving...' : 'Confirm Acknowledgment'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* PPE Evidence Snapshot Modal */}
      {selectedPpeEvidence && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(2, 6, 23, 0.92)',
          backdropFilter: 'blur(10px)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem'
        }}>
          <div style={{
            background: '#090d16',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '12px',
            maxWidth: '820px',
            width: '100%',
            overflow: 'hidden',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)'
          }}>
            <div style={{
              padding: '1rem 1.25rem',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                  Incident Evidence Snapshot • {selectedPpeEvidence.incident_id}
                </h3>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  Worker #{selectedPpeEvidence.track_id} • Missing: {selectedPpeEvidence.missing_ppe} • Sustained Violation: {selectedPpeEvidence.duration_seconds}s
                </span>
              </div>
              <button 
                onClick={() => setSelectedPpeEvidence(null)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.4rem' }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ padding: '1rem', background: '#020617', textAlign: 'center' }}>
              <img 
                src={selectedPpeEvidence.evidence_image_path} 
                alt="Incident Evidence" 
                style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.1)' }}
              />
            </div>

            <div style={{ padding: '0.85rem 1.25rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                Recorded: {new Date(selectedPpeEvidence.trigger_time_utc).toLocaleString()}
              </span>
              <button 
                onClick={() => setSelectedPpeEvidence(null)}
                className="btn-secondary"
                style={{ padding: '0.4rem 0.9rem', fontSize: '0.75rem' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PPE Acknowledge Modal */}
      {showPpeAckModal && selectedPpeForAck && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(2, 6, 23, 0.85)',
          backdropFilter: 'blur(8px)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1.5rem'
        }}>
          <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '12px',
            maxWidth: '480px',
            width: '100%',
            padding: '1.25rem',
            boxShadow: '0 20px 40px rgba(0,0,0,0.15)'
          }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
              Acknowledge PPE Incident
            </h3>
            <p style={{ fontSize: '0.775rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
              Worker #{selectedPpeForAck.track_id} violation ({selectedPpeForAck.missing_ppe}) logged at {new Date(selectedPpeForAck.trigger_time_utc).toLocaleTimeString()}.
            </p>

            <label style={{ fontSize: '0.725rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.35rem' }}>
              Supervisor Notes / Corrective Action:
            </label>
            <textarea
              value={ppeAckNote}
              onChange={(e) => setPpeAckNote(e.target.value)}
              placeholder="e.g. Worker instructed to wear helmet and goggles immediately."
              rows={3}
              style={{
                width: '100%',
                background: 'var(--bg-main)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
                padding: '0.5rem',
                fontSize: '0.775rem',
                fontFamily: 'inherit',
                marginBottom: '1rem'
              }}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
              <button
                onClick={() => {
                  setShowPpeAckModal(false);
                  setSelectedPpeForAck(null);
                }}
                className="btn-secondary"
                style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem' }}
              >
                Cancel
              </button>
              <button
                onClick={handleAcknowledgePpe}
                disabled={isAckingPpe}
                style={{
                  background: '#ef4444',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '0.4rem 0.9rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                {isAckingPpe ? 'Saving...' : 'Confirm Acknowledgment'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
