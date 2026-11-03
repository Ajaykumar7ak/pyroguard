import React, { useState, useEffect, useCallback } from 'react';
import { 
  Cloud, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle2, 
  Wifi, 
  WifiOff, 
  HardDrive, 
  Layers, 
  ExternalLink, 
  Clock, 
  Database, 
  Key, 
  RotateCw,
  FileCode,
  ShieldCheck,
  Check,
  X
} from 'lucide-react';

export default function CloudBackupPanel({ initialCloudStatus }) {
  const [cloudStatus, setCloudStatus] = useState(initialCloudStatus || null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isSyncingNow, setIsSyncingNow] = useState(false);
  const [syncHistory, setSyncHistory] = useState([]);
  const [totalHistory, setTotalHistory] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [syncFeedback, setSyncFeedback] = useState(null);

  // Sync with prop from App.jsx
  useEffect(() => {
    if (initialCloudStatus) {
      setCloudStatus(initialCloudStatus);
    }
  }, [initialCloudStatus]);

  // Fetch Cloud Status
  const fetchCloudStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    try {
      const res = await fetch('/api/cloud/status');
      if (res.ok) {
        const data = await res.json();
        setCloudStatus(data);
      }
    } catch (err) {
      console.warn('Error fetching cloud status:', err);
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  // Fetch Sync Queue History
  const fetchSyncHistory = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const res = await fetch('/api/cloud/sync-history?limit=25');
      if (res.ok) {
        const data = await res.json();
        setSyncHistory(data.records || []);
        setTotalHistory(data.total || 0);
      }
    } catch (err) {
      console.warn('Error fetching sync history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    fetchCloudStatus();
    fetchSyncHistory();
  }, [fetchCloudStatus, fetchSyncHistory]);

  // Periodic polling (every 4 seconds)
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchCloudStatus();
      fetchSyncHistory();
    }, 4000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchCloudStatus, fetchSyncHistory]);

  // Trigger Manual Sync
  const handleSyncNow = async () => {
    setIsSyncingNow(true);
    setSyncFeedback(null);
    try {
      const res = await fetch('/api/cloud/sync-now', { method: 'POST' });
      const data = await res.json();
      setSyncFeedback(data);
      fetchCloudStatus();
      fetchSyncHistory();
    } catch (err) {
      setSyncFeedback({ status: 'ERROR', message: err.message });
    } finally {
      setIsSyncingNow(false);
    }
  };

  // Retry Failed Records
  const handleRetryFailed = async () => {
    try {
      await fetch('/api/cloud/retry-failed', { method: 'POST' });
      fetchCloudStatus();
      fetchSyncHistory();
    } catch (err) {
      console.error(err);
    }
  };

  const isConfigured = Boolean(cloudStatus?.cloud_configured);
  const isInternetUp = Boolean(cloudStatus?.internet_available);
  const currentStatus = cloudStatus?.status || 'UNKNOWN';

  const getStatusBadge = () => {
    if (!cloudStatus) {
      return <span className="status-pill-badge connecting">CHECKING CLOUD...</span>;
    }
    if (!isConfigured) {
      return <span className="status-pill-badge offline">NOT CONFIGURED (LOCAL ONLY)</span>;
    }
    if (!isInternetUp) {
      return <span className="status-pill-badge error">INTERNET OFFLINE</span>;
    }
    if (currentStatus === 'SYNCED' || currentStatus === 'ONLINE' || currentStatus === 'ONLINE_IDLE') {
      return <span className="status-pill-badge online">CLOUD SYNC ACTIVE</span>;
    }
    if (currentStatus === 'AUTH_FAILURE') {
      return <span className="status-pill-badge error">AUTH FAILED</span>;
    }
    if (cloudStatus?.last_error?.includes('Could not find the table')) {
      return <span className="status-pill-badge connecting" style={{ borderColor: '#38bdf8', color: '#38bdf8' }}>SCHEMA SETUP NEEDED</span>;
    }
    if (currentStatus === 'PARTIAL_SUCCESS') {
      return <span className="status-pill-badge connecting">PARTIAL SYNC</span>;
    }
    return <span className="status-pill-badge connecting">{currentStatus}</span>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Cloud Architecture Banner */}
      <div className="arch-banner">
        <div className="arch-info">
          <div className="arch-title-box">
            <Cloud size={18} color="#38bdf8" />
            <h3 className="arch-title">Secure Cloud Backup & Offline Synchronization</h3>
          </div>
          <p className="arch-desc">
            PYROGUARD-H features a <strong>local-first data architecture</strong>. Host SQLite on this machine remains the definitive source of truth. Sensor acquisition and hardware buzzers operate completely offline. When cloud credentials are configured, the background sync worker performs idempotent batch uploads every 30 seconds to <strong>Supabase (PostgreSQL)</strong>.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
          {getStatusBadge()}
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Provider: Supabase PostgREST
          </span>
        </div>
      </div>

      {/* Sync Execution Feedback Banner */}
      {syncFeedback && (
        <div className={`diagnostic-box ${syncFeedback.status === 'SUCCESS' ? 'success' : syncFeedback.status === 'NOT_CONFIGURED' ? 'warning' : 'danger'}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700 }}>
              {syncFeedback.status === 'SUCCESS' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <span>Sync Execution Result: {syncFeedback.status}</span>
            </div>
            <button onClick={() => setSyncFeedback(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>
              <X size={14} />
            </button>
          </div>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{syncFeedback.message}</p>
          {syncFeedback.synced_count > 0 && (
            <span style={{ fontSize: '0.725rem' }}>Confirmed {syncFeedback.synced_count} records safely written to cloud database.</span>
          )}
        </div>
      )}

      {/* 4-Tile Health Metrics Grid */}
      <div className="db-stats-grid">
        {/* Metric 1: Cloud Service Reachability */}
        <div className="db-stat-tile">
          <span className="db-stat-tile-label">
            <Cloud size={13} color="#38bdf8" />
            <span>Cloud Service State</span>
          </span>
          <span className="db-stat-tile-val" style={{ 
            color: !cloudStatus ? '#94a3b8' :
                   currentStatus === 'ONLINE' || currentStatus === 'SYNCED' || currentStatus === 'ONLINE_IDLE' ? '#34d399' : 
                   !isConfigured ? '#94a3b8' : '#ef4444',
            fontSize: '1.25rem'
          }}>
            {!cloudStatus ? 'Checking...' :
             !isConfigured ? 'Not Configured' :
             !isInternetUp ? 'Internet Offline' :
             currentStatus === 'AUTH_FAILURE' ? 'Auth Failure' :
             currentStatus === 'SYNCED' || currentStatus === 'ONLINE_IDLE' ? 'Connected' : currentStatus}
          </span>
          <span className="db-stat-tile-sub">
            {cloudStatus?.supabase_url ? `Target: ${cloudStatus.supabase_url.slice(0, 28)}...` : !cloudStatus ? 'Contacting cloud worker...' : 'Local-only operation mode'}
          </span>
        </div>

        {/* Metric 2: Internet Connectivity */}
        <div className="db-stat-tile">
          <span className="db-stat-tile-label">
            {!cloudStatus ? <Wifi size={13} color="#94a3b8" /> : isInternetUp ? <Wifi size={13} color="#10b981" /> : <WifiOff size={13} color="#ef4444" />}
            <span>Host Internet Probe</span>
          </span>
          <span className="db-stat-tile-val" style={{ color: !cloudStatus ? '#94a3b8' : isInternetUp ? '#34d399' : '#ef4444' }}>
            {!cloudStatus ? 'Probing...' : isInternetUp ? 'Online' : 'Offline'}
          </span>
          <span className="db-stat-tile-sub">
            {!cloudStatus ? 'Testing reachability...' : isInternetUp ? 'Verified external reachability' : 'Retaining records in local SQLite'}
          </span>
        </div>

        {/* Metric 3: Durable Sync Queue */}
        <div className="db-stat-tile">
          <span className="db-stat-tile-label">
            <Layers size={13} color="#f59e0b" />
            <span>Pending Sync Queue</span>
          </span>
          <span className="db-stat-tile-val" style={{ color: (cloudStatus?.queue?.pending || 0) > 0 ? '#fbbf24' : 'var(--text-primary)' }}>
            {cloudStatus?.queue?.pending ?? 0}
          </span>
          <span className="db-stat-tile-sub">
            {cloudStatus?.queue?.synced ?? 0} confirmed synced • {cloudStatus?.queue?.failed ?? 0} failed
          </span>
        </div>

        {/* Metric 4: Last Sync Timestamp */}
        <div className="db-stat-tile">
          <span className="db-stat-tile-label">
            <Clock size={13} color="#10b981" />
            <span>Last Cloud Write</span>
          </span>
          <span className="db-stat-tile-val" style={{ fontSize: '1rem', color: 'var(--text-primary)' }}>
            {cloudStatus?.last_sync_utc 
              ? new Date(cloudStatus.last_sync_utc).toLocaleTimeString() 
              : 'Awaiting Sync'}
          </span>
          <span className="db-stat-tile-sub">
            {cloudStatus?.next_scheduled_utc 
              ? `Next check: ${new Date(cloudStatus.next_scheduled_utc).toLocaleTimeString()}`
              : 'Worker runs every 30s'}
          </span>
        </div>
      </div>

      {/* Control Toolbar */}
      <div className="pyro-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              onClick={handleSyncNow}
              disabled={isSyncingNow}
              className="btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1.25rem' }}
            >
              <RotateCw size={15} className={isSyncingNow ? 'animate-spin' : ''} />
              <span>{isSyncingNow ? 'Synchronizing...' : 'Sync Now'}</span>
            </button>

            {(cloudStatus?.queue?.failed || 0) > 0 && (
              <button
                onClick={handleRetryFailed}
                className="btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem' }}
              >
                <RefreshCw size={14} />
                <span>Reset & Retry Failed ({cloudStatus.queue.failed})</span>
              </button>
            )}

            <button
              onClick={() => { fetchCloudStatus(); fetchSyncHistory(); }}
              disabled={isLoadingStatus}
              className="btn-secondary"
              style={{ padding: '0.5rem 0.85rem' }}
              title="Refresh status"
            >
              <RefreshCw size={14} className={isLoadingStatus ? 'animate-spin' : ''} />
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              id="cloudAutoRefresh"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ accentColor: '#38bdf8', cursor: 'pointer' }}
            />
            <label htmlFor="cloudAutoRefresh" style={{ cursor: 'pointer' }}>
              Live Auto-Refresh (4s)
            </label>
          </div>
        </div>
      </div>

      {/* Schema Missing Notice (When Connected but Tables Not Found) */}
      {isConfigured && cloudStatus?.last_error?.includes('Could not find the table') && (
        <div className="pyro-card" style={{ borderLeft: '4px solid #38bdf8' }}>
          <div className="card-header">
            <div className="card-header-title">
              <Database size={18} color="#38bdf8" />
              <span>Supabase Schema Initialization Required</span>
            </div>
            <span className="table-badge warning">ACTION REQUIRED</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            <p>
              Supabase project is connected and authenticated with your Secret Key, but the telemetry tables (<code>sensor_readings</code>, <code>alarm_events</code>, <code>devices</code>) do not exist yet.
            </p>
            <div style={{ background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.85rem 1rem' }}>
              <strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '0.4rem' }}>
                Quick 1-Minute Step:
              </strong>
              <ol style={{ paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <li>Open your Supabase SQL Editor: <a href="https://supabase.com/dashboard/project/bboxmdwzltmfuwatrgtx/sql/new" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>https://supabase.com/dashboard/project/bboxmdwzltmfuwatrgtx/sql/new</a></li>
                <li>Copy and paste the SQL script from <code style={{ color: 'var(--accent-primary)' }}>supabase/migrations/20261018000000_pyroguard_schema.sql</code> and click <strong>Run</strong>.</li>
                <li>Click <strong>Reset &amp; Retry Failed</strong> or <strong>Sync Now</strong> above to immediately upload all queued telemetry.</li>
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* Operator Setup Guide Box (When Not Configured) */}
      {!isConfigured && (
        <div className="pyro-card" style={{ borderLeft: '4px solid #f59e0b' }}>
          <div className="card-header">
            <div className="card-header-title">
              <Key size={18} color="#f59e0b" />
              <span>Supabase Cloud Backup Operator Setup</span>
            </div>
            <span className="table-badge warning">SETUP REQUIRED</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            <p>
              To enable automatic 30-second cloud synchronization, configure your Supabase credentials in the backend environment. <strong>Privileged keys are stored securely on the local host and never exposed through client JavaScript.</strong>
            </p>

            <div style={{ background: 'var(--bg-main)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.85rem 1rem' }}>
              <strong style={{ color: 'var(--text-primary)', display: 'block', marginBottom: '0.4rem' }}>
                Quick Setup Steps:
              </strong>
              <ol style={{ paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <li>Create a free project at <a href="https://supabase.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-primary)' }}>supabase.com</a>.</li>
                <li>Run the schema script in <code style={{ color: '#ef4444' }}>docs/SUPABASE_SETUP_GUIDE.md</code> via the Supabase SQL Editor.</li>
                <li>Copy <code style={{ color: 'var(--accent-primary)' }}>backend/.env.example</code> to <code style={{ color: 'var(--accent-primary)' }}>backend/.env</code> and enter your Project URL &amp; Service Role Key:</li>
              </ol>

              <pre className="telemetry-code-block" style={{ marginTop: '0.65rem' }}>
{`CLOUD_SYNC_ENABLED=true
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...your_service_role_secret`}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Durable Sync Queue Audit Log Table */}
      <div className="pyro-card">
        <div className="card-header">
          <div className="card-header-title">
            <Database size={18} color="#38bdf8" />
            <span>Staged Synchronization Queue Log ({totalHistory} Total Items)</span>
          </div>
          <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Batch Size: {cloudStatus?.batch_size || 50} records • 30s Interval
          </span>
        </div>

        {syncHistory.length === 0 ? (
          <div className="empty-state-box">
            <CheckCircle2 size={36} color="#10b981" />
            <strong style={{ color: 'var(--text-primary)' }}>Sync Queue Empty</strong>
            <p>Zero records staged in the synchronization queue. New sensor readings and alarm events are queued automatically.</p>
          </div>
        ) : (
          <div className="pyro-table-container">
            <table className="pyro-table">
              <thead>
                <tr>
                  <th>Queue ID</th>
                  <th>Record Type</th>
                  <th>Payload Ref</th>
                  <th>Created At (UTC)</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Last Error</th>
                </tr>
              </thead>
              <tbody>
                {syncHistory.map((rec) => {
                  const isSynced = rec.sync_status === 'SYNCED';
                  const isFailed = rec.sync_status === 'FAILED';

                  return (
                    <tr key={rec.queue_id} className={isFailed ? 'row-danger' : ''}>
                      <td style={{ color: 'var(--accent-primary)' }} title={rec.queue_id}>
                        {rec.queue_id.slice(0, 8)}...
                      </td>
                      <td>
                        <span className={`table-badge ${rec.record_type === 'alarm_event' ? 'danger' : 'info'}`}>
                          {rec.record_type}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-primary)' }} title={rec.payload_reference}>
                        {rec.payload_reference.slice(0, 8)}...
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ color: 'var(--text-primary)' }}>{new Date(rec.created_at_utc).toLocaleTimeString()}</span>
                          <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)' }}>
                            {rec.created_at_utc.split('T')[0]}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className={`table-badge ${isSynced ? 'success' : isFailed ? 'danger' : 'warning'}`}>
                          {rec.sync_status}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontFamily: 'var(--font-mono)' }}>
                          {rec.attempt_count}
                        </span>
                      </td>
                      <td>
                        {rec.last_error ? (
                          <span style={{ color: '#f87171', fontSize: '0.7rem', maxWidth: '200px', display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis' }} title={rec.last_error}>
                            {rec.last_error}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
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
    </div>
  );
}
