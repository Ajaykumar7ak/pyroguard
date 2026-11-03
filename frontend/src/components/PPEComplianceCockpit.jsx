import React, { useState, useEffect, useCallback } from 'react';
import { 
  ShieldCheck, 
  ShieldAlert, 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  Camera, 
  User, 
  Users, 
  Activity, 
  RefreshCw, 
  FileText, 
  Check, 
  X, 
  ExternalLink, 
  AlertOctagon, 
  Eye,
  Maximize2,
  Info
} from 'lucide-react';

export default function PPEComplianceCockpit({ onSelectStreamMode, currentStreamMode }) {
  const [ppeStatus, setPpeStatus] = useState(null);
  const [incidents, setIncidents] = useState([]);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isLoadingIncidents, setIsLoadingIncidents] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState(null);
  const [acknowledgingId, setAcknowledgingId] = useState(null);
  const [ackNote, setAckNote] = useState('');
  const [showAckModal, setShowAckModal] = useState(false);
  const [incidentToAck, setIncidentToAck] = useState(null);

  // Fetch PPE Inference Engine status
  const fetchPPEStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/ppe/status');
      if (res.ok) {
        const data = await res.json();
        setPpeStatus(data);
      }
    } catch (err) {
      console.debug('Failed to fetch PPE status:', err);
    }
  }, []);

  // Fetch Recent PPE Incidents from SQLite
  const fetchIncidents = useCallback(async () => {
    try {
      const res = await fetch('/api/ppe/incidents?limit=6');
      if (res.ok) {
        const data = await res.json();
        setIncidents(data.incidents || []);
      }
    } catch (err) {
      console.debug('Failed to fetch PPE incidents:', err);
    }
  }, []);

  // Initial and recurring poll
  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      if (!isMounted) return;
      await fetchPPEStatus();
      await fetchIncidents();
    };
    run();
    const statusInterval = setInterval(fetchPPEStatus, 1500);
    const incidentInterval = setInterval(fetchIncidents, 3500);

    return () => {
      isMounted = false;
      clearInterval(statusInterval);
      clearInterval(incidentInterval);
    };
  }, [fetchPPEStatus, fetchIncidents]);

  // Acknowledge Incident Handler
  const handleAcknowledge = async () => {
    if (!incidentToAck) return;
    setAcknowledgingId(incidentToAck.incident_id);
    try {
      const res = await fetch(`/api/ppe/incidents/${incidentToAck.incident_id}/acknowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: ackNote.trim() || 'Acknowledged by operator in Overview cockpit.' })
      });
      if (res.ok) {
        setShowAckModal(false);
        setAckNote('');
        setIncidentToAck(null);
        await fetchIncidents();
      }
    } catch (err) {
      console.error('Failed to acknowledge PPE incident:', err);
    } finally {
      setAcknowledgingId(null);
    }
  };

  const aiStatus = ppeStatus?.ai_status || 'INITIALIZING';
  const workers = ppeStatus?.workers || [];
  const activeViolationsCount = ppeStatus?.active_violations_count || 0;
  const targetFps = ppeStatus?.target_fps || 5.0;
  const actualFps = ppeStatus?.actual_fps || 0.0;
  const latencyMs = ppeStatus?.latency_ms || 0.0;
  const threshold = ppeStatus?.violation_threshold_sec || 10.0;
  const reqCategories = ppeStatus?.required_categories || ['helmet', 'goggles', 'gloves'];
  const openIncidents = incidents.filter(i => i.status === 'OPEN');

  // Handle dynamic config updates via API
  const handleUpdateConfig = async (newConfig) => {
    try {
      const res = await fetch('/api/ppe/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });
      if (res.ok) {
        await fetchPPEStatus();
      }
    } catch (e) {
      console.error('Failed to update PPE config:', e);
    }
  };

  const handleToggleCategory = (cat) => {
    let next;
    if (reqCategories.includes(cat)) {
      next = reqCategories.filter(c => c !== cat);
    } else {
      next = [...reqCategories, cat];
    }
    if (next.length === 0) next = ['helmet']; // Keep at least 1 required
    handleUpdateConfig({ required_categories: next });
  };

  const handleSetThreshold = (sec) => {
    handleUpdateConfig({ violation_threshold_sec: sec });
  };

  // AI Status Pill Styling
  const getAiStatusBadge = (status) => {
    switch (status) {
      case 'ONLINE':
        return { label: 'ONLINE', bg: 'rgba(16, 185, 129, 0.15)', color: '#34d399', border: 'rgba(16, 185, 129, 0.3)' };
      case 'CAMERA_OFFLINE':
        return { label: 'CAMERA OFFLINE', bg: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: 'rgba(245, 158, 11, 0.3)' };
      case 'STALE_FEED':
        return { label: 'FEED STALE', bg: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: 'rgba(245, 158, 11, 0.3)' };
      case 'MODEL_UNAVAILABLE':
        return { label: 'MODEL UNAVAILABLE', bg: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: 'rgba(239, 68, 68, 0.3)' };
      case 'IDLE':
        return { label: 'IDLE (NO FRAMES)', bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: 'rgba(59, 130, 246, 0.3)' };
      default:
        return { label: status, bg: 'rgba(148, 163, 184, 0.15)', color: '#94a3b8', border: 'rgba(148, 163, 184, 0.3)' };
    }
  };

  const statusStyle = getAiStatusBadge(aiStatus);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      
      {/* Active Sustained PPE Incident Banner */}
      {openIncidents.length > 0 && (
        <div style={{
          background: 'linear-gradient(90deg, rgba(239, 68, 68, 0.25) 0%, rgba(185, 28, 28, 0.15) 100%)',
          border: '1px solid #ef4444',
          borderRadius: '10px',
          padding: '0.875rem 1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
          boxShadow: '0 0 20px rgba(239, 68, 68, 0.25)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
            <div style={{ padding: '0.5rem', background: '#ef4444', borderRadius: '50%', color: '#ffffff' }}>
              <AlertOctagon size={20} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#ffffff', letterSpacing: '0.02em' }}>
                CRITICAL PPE VIOLATION ({threshold.toFixed(0)}s THRESHOLD CONFIRMED)
              </div>
              <div style={{ fontSize: '0.775rem', color: '#fca5a5', marginTop: '0.2rem' }}>
                {openIncidents.length} active incident(s) requiring supervisor review • Evidence snapshot captured & saved locally
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <button
              onClick={() => {
                setIncidentToAck(openIncidents[0]);
                setShowAckModal(true);
              }}
              style={{
                background: '#ef4444',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '0.45rem 0.9rem',
                fontSize: '0.775rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem'
              }}
            >
              <Check size={14} />
              <span>Acknowledge #{openIncidents[0].track_id}</span>
            </button>
          </div>
        </div>
      )}

      {/* Main AI Inference Cockpit Header & Metrics */}
      <div className="pyro-card" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.85rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ padding: '0.5rem', background: 'rgba(59, 130, 246, 0.15)', borderRadius: '8px', color: '#60a5fa' }}>
              <ShieldCheck size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
                  Pretrained AI PPE Compliance Monitor
                </h3>
                <span style={{
                  background: statusStyle.bg,
                  color: statusStyle.color,
                  border: `1px solid ${statusStyle.border}`,
                  padding: '0.2rem 0.6rem',
                  borderRadius: '12px',
                  fontSize: '0.675rem',
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.05em'
                }}>
                  ● {statusStyle.label}
                </span>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'block', marginTop: '0.2rem' }}>
                Dual YOLOv8n (Person Tracker + 10-Class Protective Equipment Detector) • Local CPU Inference
              </span>
            </div>
          </div>

          {/* Quick HUD View Toggle & Manual Refresh */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            {onSelectStreamMode && (
              <button
                onClick={() => onSelectStreamMode(currentStreamMode === 'ai_hud' ? 'proxy' : 'ai_hud')}
                style={{
                  background: currentStreamMode === 'ai_hud' ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.05)',
                  border: `1px solid ${currentStreamMode === 'ai_hud' ? '#3b82f6' : 'var(--border-subtle)'}`,
                  color: currentStreamMode === 'ai_hud' ? '#60a5fa' : 'var(--text-secondary)',
                  borderRadius: '6px',
                  padding: '0.4rem 0.75rem',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  transition: 'all 0.15s ease'
                }}
              >
                <Eye size={14} />
                <span>{currentStreamMode === 'ai_hud' ? 'AI HUD Stream Active' : 'Toggle AI HUD Stream'}</span>
              </button>
            )}

            <button
              onClick={() => {
                fetchPPEStatus();
                fetchIncidents();
              }}
              className="btn-secondary"
              style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
              title="Refresh AI Status"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {/* Inference Telemetry Tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.85rem' }}>
          
          <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.75rem' }}>
            <span style={{ fontSize: '0.675rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Activity size={12} color="#0284c7" />
              Inference Speed
            </span>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.25rem', fontWeight: 700, color: '#0f172a', marginTop: '0.3rem' }}>
              {actualFps > 0 ? `${actualFps} FPS` : `${targetFps} FPS`}
            </div>
            <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)' }}>
              Target: {targetFps} FPS ({latencyMs}ms latency)
            </span>
          </div>

          <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.75rem' }}>
            <span style={{ fontSize: '0.675rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Users size={12} color="#7c3aed" />
              Tracked Workers
            </span>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.25rem', fontWeight: 700, color: '#0f172a', marginTop: '0.3rem' }}>
              {workers.length}
            </div>
            <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)' }}>
              ByteTrack spatial IDs
            </span>
          </div>

          <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.75rem' }}>
            <span style={{ fontSize: '0.675rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <AlertTriangle size={12} color={activeViolationsCount > 0 ? '#ef4444' : '#059669'} />
              Active Violations
            </span>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.25rem', fontWeight: 700, color: activeViolationsCount > 0 ? '#ef4444' : '#059669', marginTop: '0.3rem' }}>
              {activeViolationsCount}
            </div>
            <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)' }}>
              {activeViolationsCount > 0 ? 'Countdown in progress' : 'All compliant / clear'}
            </span>
          </div>

          <div style={{ background: '#f8fafc', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.75rem' }}>
            <span style={{ fontSize: '0.675rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Clock size={12} color="#d97706" />
              Violation Timer
            </span>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.25rem', fontWeight: 700, color: '#0f172a', marginTop: '0.3rem' }}>
              {threshold.toFixed(1)}s
            </div>
            <span style={{ fontSize: '0.675rem', color: 'var(--text-muted)' }}>
              Evidence auto-trigger
            </span>
          </div>

        </div>

        {/* Interactive Operator Control Strip */}
        {/* Interactive Operator Control Strip */}
        <div style={{
          marginTop: '1rem',
          padding: '0.75rem 1rem',
          background: '#f8fafc',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem'
        }}>
          {/* Threshold Selection */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.725rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              Countdown Threshold:
            </span>
            {[5, 10, 30, 60].map((sec) => (
              <button
                key={sec}
                onClick={() => handleSetThreshold(sec)}
                style={{
                  background: Math.round(threshold) === sec ? '#0284c7' : '#ffffff',
                  color: Math.round(threshold) === sec ? '#ffffff' : '#334155',
                  border: `1px solid ${Math.round(threshold) === sec ? '#0284c7' : '#cbd5e1'}`,
                  borderRadius: '5px',
                  padding: '0.25rem 0.65rem',
                  fontSize: '0.725rem',
                  fontWeight: Math.round(threshold) === sec ? 700 : 500,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  boxShadow: 'var(--shadow-sm)'
                }}
              >
                {sec}s
              </button>
            ))}
          </div>

          {/* Required PPE Categories Toggles */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.725rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              Required Safety Gear:
            </span>
            {['helmet', 'goggles', 'gloves', 'mask', 'shoes'].map((cat) => {
              const isReq = reqCategories.includes(cat);
              return (
                <button
                  key={cat}
                  onClick={() => handleToggleCategory(cat)}
                  style={{
                    background: isReq ? '#f0fdf4' : '#ffffff',
                    color: isReq ? '#15803d' : '#64748b',
                    border: `1px solid ${isReq ? '#86efac' : '#cbd5e1'}`,
                    borderRadius: '5px',
                    padding: '0.25rem 0.6rem',
                    fontSize: '0.725rem',
                    fontWeight: isReq ? 700 : 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    textTransform: 'capitalize',
                    boxShadow: 'var(--shadow-sm)'
                  }}
                >
                  <span>{isReq ? '✓' : '+'}</span>
                  <span>{cat}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Model Capability & Honest Limitations Notice */}
        <div style={{
          marginTop: '1rem',
          background: '#f0f9ff',
          border: '1px solid #bae6fd',
          borderRadius: '8px',
          padding: '0.65rem 0.9rem',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.65rem'
        }}>
          <Info size={16} color="#0284c7" style={{ marginTop: '0.15rem', flexShrink: 0 }} />
          <div style={{ fontSize: '0.725rem', color: '#334155', lineHeight: '1.45' }}>
            <strong style={{ color: '#0369a1' }}>Pretrained PPE Coverage & Domain Scope:</strong> Supported classes include{' '}
            <span style={{ color: '#059669', fontWeight: 600 }}>Safety Helmet (Hardhat & Motorcycle)</span>,{' '}
            <span style={{ color: '#059669', fontWeight: 600 }}>Safety Goggles</span>,{' '}
            <span style={{ color: '#059669', fontWeight: 600 }}>Protective Gloves</span>,{' '}
            <span style={{ color: '#059669', fontWeight: 600 }}>Face Mask / Respirator</span>, and{' '}
            <span style={{ color: '#059669', fontWeight: 600 }}>Protective Footwear</span>.{' '}
            <span style={{ color: '#b45309' }}>
              Note: Specialized antistatic overalls require custom domain dataset fine-tuning.
            </span>
          </div>
        </div>

      </div>

      {/* Live Tracked Workers Cards Section */}
      <div className="pyro-card" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <User size={18} color="#0284c7" />
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
              Live Tracked Workers ({workers.length})
            </h4>
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            Grace Period: 2 Frames • Sustained Threshold: {threshold.toFixed(0)}s
          </span>
        </div>

        {workers.length === 0 ? (
          <div style={{
            background: '#f8fafc',
            border: '1px dashed #cbd5e1',
            borderRadius: '8px',
            padding: '2rem',
            textAlign: 'center'
          }}>
            <Users size={32} color="#94a3b8" style={{ margin: '0 auto 0.65rem' }} />
            <div style={{ fontWeight: 600, color: '#334155', fontSize: '0.875rem' }}>
              {aiStatus === 'CAMERA_OFFLINE' ? 'Camera Feed Offline' : 'No Workers In Field of View'}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', maxWidth: '420px', margin: '0.25rem auto 0' }}>
              {aiStatus === 'CAMERA_OFFLINE' 
                ? 'Connect camera or verify ESP32-CAM stream on port 80/81 to initiate AI person tracking.' 
                : 'The AI engine is actively evaluating incoming frames. When a person enters the camera viewport, their track ID and PPE compliance will appear here.'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
            {workers.map((worker) => {
              const hasViolation = worker.missing_categories && worker.missing_categories.length > 0;
              const elapsed = worker.violation_elapsed_sec || 0;
              const remaining = Math.max(0, threshold - elapsed);
              const progressPct = Math.min(100, (elapsed / threshold) * 100);

              return (
                <div 
                  key={worker.track_id}
                  style={{
                    background: hasViolation ? 'rgba(239, 68, 68, 0.06)' : 'rgba(15, 23, 42, 0.6)',
                    border: `1px solid ${hasViolation ? 'rgba(239, 68, 68, 0.35)' : 'rgba(255, 255, 255, 0.08)'}`,
                    borderRadius: '10px',
                    padding: '1rem',
                    position: 'relative',
                    overflow: 'hidden'
                  }}
                >
                  {/* Worker Title & Status Badge */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{
                        background: hasViolation ? '#ef4444' : '#10b981',
                        color: '#ffffff',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        fontFamily: 'var(--font-mono)',
                        padding: '0.2rem 0.5rem',
                        borderRadius: '4px'
                      }}>
                        Worker #{worker.track_id}
                      </span>
                    </div>

                    <span style={{
                      fontSize: '0.675rem',
                      fontWeight: 700,
                      fontFamily: 'var(--font-mono)',
                      color: hasViolation ? '#ef4444' : '#10b981'
                    }}>
                      {hasViolation ? 'VIOLATION DETECTED' : 'FULLY COMPLIANT'}
                    </span>
                  </div>

                  {/* PPE Categories Checklist Pills */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.85rem' }}>
                    {['helmet', 'goggles', 'gloves', 'mask', 'shoes'].map((cat) => {
                      const catStatus = worker.category_status ? worker.category_status[cat] : 'UNKNOWN';
                      let catColor = '#64748b';
                      let catBg = 'rgba(100, 116, 139, 0.15)';
                      let icon = null;

                      if (catStatus === 'COMPLIANT') {
                        catColor = '#34d399';
                        catBg = 'rgba(16, 185, 129, 0.15)';
                        icon = <Check size={11} />;
                      } else if (catStatus === 'VIOLATION') {
                        catColor = '#f87171';
                        catBg = 'rgba(239, 68, 68, 0.2)';
                        icon = <X size={11} />;
                      }

                      return (
                        <span 
                          key={cat}
                          style={{
                            background: catBg,
                            color: catColor,
                            border: `1px solid ${catColor}33`,
                            padding: '0.2rem 0.5rem',
                            borderRadius: '4px',
                            fontSize: '0.675rem',
                            fontFamily: 'var(--font-mono)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            textTransform: 'capitalize'
                          }}
                        >
                          {icon}
                          {cat}
                        </span>
                      );
                    })}
                  </div>

                  {/* Violation Countdown Timer Bar */}
                  {hasViolation ? (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', marginBottom: '0.3rem', fontFamily: 'var(--font-mono)' }}>
                        <span style={{ color: '#f87171' }}>
                          Missing: {worker.missing_categories.join(', ')}
                        </span>
                        <span style={{ color: remaining === 0 ? '#ef4444' : '#fbbf24', fontWeight: 700 }}>
                          {remaining === 0 ? 'ALERT TRIGGERED' : `Alert in ${remaining.toFixed(1)}s`}
                        </span>
                      </div>

                      {/* Visual Countdown Progress Bar */}
                      <div style={{ height: '7px', background: 'rgba(2, 6, 23, 0.8)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div 
                          style={{
                            width: `${progressPct}%`,
                            height: '100%',
                            background: remaining === 0 ? '#ef4444' : progressPct > 75 ? '#f59e0b' : '#38bdf8',
                            transition: 'width 0.3s ease'
                          }} 
                        />
                      </div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                        Elapsed sustained duration: {elapsed.toFixed(1)}s / {threshold.toFixed(1)}s
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.725rem', color: '#34d399', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <CheckCircle2 size={13} />
                      <span>Compliant with all required safety gear</span>
                    </div>
                  )}

                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Captured Evidence Gallery & Recent Incidents Log */}
      <div className="pyro-card" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Camera size={18} color="#0284c7" />
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0f172a', margin: 0 }}>
              Captured Evidence Snapshots & Incidents ({incidents.length})
            </h4>
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            Stored locally with timestamped evidence ({threshold.toFixed(0)}s threshold)
          </span>
        </div>

        {incidents.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)', fontSize: '0.775rem' }}>
            No PPE incidents recorded yet. Sustained violations beyond the safety threshold will automatically capture evidence snapshots here.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
            {incidents.map((inc) => {
              const isOpen = inc.status === 'OPEN';
              const isAck = inc.status === 'ACKNOWLEDGED';

              return (
                <div 
                  key={inc.incident_id}
                  style={{
                    background: 'var(--bg-main)',
                    border: `1px solid ${isOpen ? 'rgba(239, 68, 68, 0.4)' : 'var(--border-subtle)'}`,
                    borderRadius: '8px',
                    padding: '0.75rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.65rem'
                  }}
                >
                  {/* Thumbnail Preview */}
                  <div 
                    onClick={() => setSelectedEvidence(inc)}
                    style={{
                      height: '110px',
                      background: '#090d16',
                      borderRadius: '6px',
                      overflow: 'hidden',
                      position: 'relative',
                      cursor: 'pointer',
                      border: '1px solid rgba(255, 255, 255, 0.05)'
                    }}
                  >
                    {inc.evidence_image_path ? (
                      <img 
                        src={inc.evidence_image_path} 
                        alt={inc.incident_id}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => {
                          e.target.style.display = 'none';
                        }}
                      />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>
                        <Camera size={24} />
                      </div>
                    )}
                    <div style={{
                      position: 'absolute',
                      bottom: '0.4rem',
                      right: '0.4rem',
                      background: 'rgba(2, 6, 23, 0.85)',
                      padding: '0.2rem 0.4rem',
                      borderRadius: '4px',
                      fontSize: '0.65rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      color: '#ffffff'
                    }}>
                      <Maximize2 size={10} />
                      <span>View</span>
                    </div>
                  </div>

                  {/* Incident Info */}
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                        Worker #{inc.track_id}
                      </span>
                      <span style={{
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        padding: '0.15rem 0.45rem',
                        borderRadius: '4px',
                        background: isOpen ? 'rgba(239, 68, 68, 0.12)' : isAck ? 'rgba(245, 158, 11, 0.12)' : 'rgba(16, 185, 129, 0.12)',
                        color: isOpen ? '#dc2626' : isAck ? '#d97706' : '#059669'
                      }}>
                        {inc.status}
                      </span>
                    </div>

                    <div style={{ fontSize: '0.7rem', color: '#dc2626', marginTop: '0.25rem', fontWeight: 600 }}>
                      Missing: {inc.missing_ppe}
                    </div>

                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.2rem', fontFamily: 'var(--font-mono)' }}>
                      Duration: {inc.duration_seconds}s • {new Date(inc.trigger_time_utc).toLocaleTimeString()}
                    </div>
                  </div>

                  {/* Action button if OPEN */}
                  {isOpen && (
                    <button
                      onClick={() => {
                        setIncidentToAck(inc);
                        setShowAckModal(true);
                      }}
                      className="btn-secondary"
                      style={{ fontSize: '0.7rem', padding: '0.35rem 0.6rem', width: '100%', justifyContent: 'center' }}
                    >
                      <Check size={12} />
                      <span>Acknowledge</span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Full-Screen High-Res Evidence Snapshot Modal */}
      {selectedEvidence && (
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
                  Incident Evidence Snapshot • {selectedEvidence.incident_id}
                </h3>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                  Worker #{selectedEvidence.track_id} • Missing: {selectedEvidence.missing_ppe} • Sustained Violation: {selectedEvidence.duration_seconds}s
                </span>
              </div>
              <button 
                onClick={() => setSelectedEvidence(null)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '0.4rem' }}
              >
                <X size={20} />
              </button>
            </div>

            <div style={{ padding: '1rem', background: '#020617', textAlign: 'center' }}>
              <img 
                src={selectedEvidence.evidence_image_path} 
                alt="Incident Evidence" 
                style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.1)' }}
              />
            </div>

            <div style={{ padding: '0.85rem 1.25rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.725rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                Recorded: {new Date(selectedEvidence.trigger_time_utc).toLocaleString()}
              </span>
              <button 
                onClick={() => setSelectedEvidence(null)}
                className="btn-secondary"
                style={{ padding: '0.4rem 0.9rem', fontSize: '0.75rem' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Operator Acknowledge Modal */}
      {showAckModal && incidentToAck && (
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
              Worker #{incidentToAck.track_id} violation ({incidentToAck.missing_ppe}) logged at {new Date(incidentToAck.trigger_time_utc).toLocaleTimeString()}.
            </p>

            <label style={{ fontSize: '0.725rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '0.35rem' }}>
              Supervisor Notes / Corrective Action:
            </label>
            <textarea
              value={ackNote}
              onChange={(e) => setAckNote(e.target.value)}
              placeholder="e.g. Worker instructed to put on safety goggles and helmet immediately."
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
                  setShowAckModal(false);
                  setIncidentToAck(null);
                }}
                className="btn-secondary"
                style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem' }}
              >
                Cancel
              </button>
              <button
                onClick={handleAcknowledge}
                disabled={acknowledgingId !== null}
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
                {acknowledgingId ? 'Saving...' : 'Confirm Acknowledgment'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
