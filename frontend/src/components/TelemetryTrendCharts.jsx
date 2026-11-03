import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  TrendingUp, 
  Thermometer, 
  Droplets, 
  Clock, 
  RefreshCw, 
  AlertTriangle,
  Info
} from 'lucide-react';

export default function TelemetryTrendCharts() {
  const [timeRange, setTimeRange] = useState('1h'); // '1h' or '24h'
  const [readings, setReadings] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);
  const [hoveredPoint, setHoveredPoint] = useState(null);

  // Fetch real historical data from /api/sensor/readings/history
  const fetchTrendData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const durationMs = timeRange === '1h' ? 3600 * 1000 : 24 * 3600 * 1000;
      const startTimeUtc = new Date(Date.now() - durationMs).toISOString();

      const params = new URLSearchParams({
        limit: '300',
        offset: '0',
        start_time: startTimeUtc
      });

      const res = await fetch(`/api/sensor/readings/history?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to fetch historical telemetry`);
      }
      const data = await res.json();
      
      // Readings come newest first from SQLite -> reverse to chronological order (oldest to newest)
      const rawReadings = (data.readings || []).slice().reverse();

      // Filter only real, valid telemetry points (do NOT invent or interpolate fake data)
      const validPoints = rawReadings.filter(r => 
        r.temperature_c !== null && 
        r.temperature_c !== undefined && 
        !isNaN(r.temperature_c) &&
        r.humidity_pct !== null && 
        r.humidity_pct !== undefined && 
        !isNaN(r.humidity_pct) &&
        r.timestamp_utc
      );

      setReadings(validPoints);
      setLastFetchedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [timeRange]);

  // Fetch on mount or range switch
  useEffect(() => {
    fetchTrendData();
  }, [fetchTrendData]);

  // Background refresh every 30s to avoid excessive database polling
  useEffect(() => {
    const interval = setInterval(fetchTrendData, 30000);
    return () => clearInterval(interval);
  }, [fetchTrendData]);

  // Statistics for temperature
  const tempStats = useMemo(() => {
    if (readings.length === 0) return null;
    const values = readings.map(r => r.temperature_c);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const current = values[values.length - 1];
    return { min, max, avg, current };
  }, [readings]);

  // Statistics for humidity
  const humStats = useMemo(() => {
    if (readings.length === 0) return null;
    const values = readings.map(r => r.humidity_pct);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const current = values[values.length - 1];
    return { min, max, avg, current };
  }, [readings]);

  // Helper to build Pure SVG Chart
  const renderSvgChart = (metricType) => {
    const isTemp = metricType === 'temperature';
    const unit = isTemp ? '°C' : '%';
    const strokeColor = isTemp ? '#f97316' : '#38bdf8';
    const gradientId = isTemp ? 'tempGradient' : 'humGradient';
    const stats = isTemp ? tempStats : humStats;

    if (readings.length === 0) {
      return (
        <div style={{
          height: '180px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
          color: 'var(--text-muted)',
          background: 'rgba(2, 6, 23, 0.4)',
          borderRadius: '8px',
          border: '1px dashed var(--border-subtle)',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.75rem',
          textAlign: 'center',
          padding: '1rem'
        }}>
          <Clock size={24} opacity={0.6} />
          <span>No historical {isTemp ? 'temperature' : 'humidity'} records in the last {timeRange === '1h' ? '1 hour' : '24 hours'}.</span>
          <span style={{ fontSize: '0.675rem', color: 'var(--text-secondary)' }}>
            Real sensor readings logged into SQLite will populate this SVG trendline automatically.
          </span>
        </div>
      );
    }

    const viewBoxWidth = 520;
    const viewBoxHeight = 170;
    const padding = { top: 20, right: 20, bottom: 30, left: 45 };
    const chartWidth = viewBoxWidth - padding.left - padding.right;
    const chartHeight = viewBoxHeight - padding.top - padding.bottom;

    // Y-Axis Range with minimum dynamic span
    const rawMin = stats.min;
    const rawMax = stats.max;
    const span = Math.max(isTemp ? 4 : 8, (rawMax - rawMin) * 1.25);
    const yCenter = (rawMin + rawMax) / 2;
    const yMin = Math.max(isTemp ? -10 : 0, Math.floor(yCenter - span / 2));
    const yMax = isTemp ? Math.ceil(yCenter + span / 2) : Math.min(100, Math.ceil(yCenter + span / 2));

    const yMid = ((yMin + yMax) / 2).toFixed(1);

    // X-Axis range from timestamps
    const timestamps = readings.map(r => new Date(r.timestamp_utc).getTime());
    const tMin = timestamps[0];
    const tMax = timestamps[timestamps.length - 1];
    const tSpan = Math.max(1000, tMax - tMin);

    // Compute coordinate points
    const points = readings.map((r, idx) => {
      const t = timestamps[idx];
      const val = isTemp ? r.temperature_c : r.humidity_pct;
      
      const x = tSpan === 0 
        ? padding.left + chartWidth / 2 
        : padding.left + ((t - tMin) / tSpan) * chartWidth;
        
      const y = padding.top + chartHeight - ((val - yMin) / (yMax - yMin)) * chartHeight;
      return { x, y, val, time: r.timestamp_utc, raw: r };
    });

    // Build SVG path strings
    const pathD = points.length === 1
      ? `M ${padding.left} ${points[0].y} L ${padding.left + chartWidth} ${points[0].y}`
      : points.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`, '');

    const areaD = points.length > 1
      ? `${pathD} L ${points[points.length - 1].x.toFixed(1)} ${padding.top + chartHeight} L ${points[0].x.toFixed(1)} ${padding.top + chartHeight} Z`
      : '';

    // X-Axis Ticks
    const startTimeLabel = new Date(tMin).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const endTimeLabel = new Date(tMax).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const midTimeLabel = new Date(tMin + tSpan / 2).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return (
      <svg 
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`} 
        className="trend-chart-svg"
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.35" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Horizontal Gridlines & Y-Axis Labels */}
        {/* Top line (Max) */}
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left + chartWidth}
          y2={padding.top}
          stroke="rgba(255, 255, 255, 0.08)"
          strokeDasharray="3 3"
        />
        <text
          x={padding.left - 8}
          y={padding.top + 4}
          fill="var(--text-secondary)"
          fontSize="10"
          fontFamily="var(--font-mono)"
          textAnchor="end"
        >
          {yMax}{unit}
        </text>

        {/* Mid line */}
        <line
          x1={padding.left}
          y1={padding.top + chartHeight / 2}
          x2={padding.left + chartWidth}
          y2={padding.top + chartHeight / 2}
          stroke="rgba(255, 255, 255, 0.05)"
          strokeDasharray="2 2"
        />
        <text
          x={padding.left - 8}
          y={padding.top + chartHeight / 2 + 4}
          fill="var(--text-secondary)"
          fontSize="10"
          fontFamily="var(--font-mono)"
          textAnchor="end"
        >
          {yMid}{unit}
        </text>

        {/* Baseline (Min) */}
        <line
          x1={padding.left}
          y1={padding.top + chartHeight}
          x2={padding.left + chartWidth}
          y2={padding.top + chartHeight}
          stroke="rgba(255, 255, 255, 0.12)"
        />
        <text
          x={padding.left - 8}
          y={padding.top + chartHeight + 4}
          fill="var(--text-secondary)"
          fontSize="10"
          fontFamily="var(--font-mono)"
          textAnchor="end"
        >
          {yMin}{unit}
        </text>

        {/* Filled Area under Curve */}
        {areaD && (
          <path d={areaD} fill={`url(#${gradientId})`} />
        )}

        {/* The Real Data Path Line */}
        <path
          d={pathD}
          fill="none"
          stroke={strokeColor}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Data Point Dots (Hoverable) */}
        {points.map((pt, i) => (
          <g key={i}>
            <circle
              cx={pt.x}
              cy={pt.y}
              r={points.length > 50 ? 2 : 3.5}
              fill={strokeColor}
              stroke="#0f172a"
              strokeWidth="1.5"
              style={{ cursor: 'pointer', transition: 'r 0.15s ease' }}
              onMouseEnter={() => setHoveredPoint({ ...pt, metricType, unit })}
              onMouseLeave={() => setHoveredPoint(null)}
            >
              <title>{`${isTemp ? 'Temp' : 'Humidity'}: ${pt.val}${unit} at ${new Date(pt.time).toLocaleTimeString()}`}</title>
            </circle>
          </g>
        ))}

        {/* X-Axis Time Labels */}
        <text
          x={padding.left}
          y={viewBoxHeight - 8}
          fill="var(--text-muted)"
          fontSize="9.5"
          fontFamily="var(--font-mono)"
          textAnchor="start"
        >
          {startTimeLabel}
        </text>

        {points.length > 1 && (
          <text
            x={padding.left + chartWidth / 2}
            y={viewBoxHeight - 8}
            fill="var(--text-muted)"
            fontSize="9.5"
            fontFamily="var(--font-mono)"
            textAnchor="middle"
          >
            {midTimeLabel}
          </text>
        )}

        <text
          x={padding.left + chartWidth}
          y={viewBoxHeight - 8}
          fill="var(--text-muted)"
          fontSize="9.5"
          fontFamily="var(--font-mono)"
          textAnchor="end"
        >
          {endTimeLabel}
        </text>
      </svg>
    );
  };

  return (
    <div className="pyro-card" style={{ padding: '1.25rem' }}>
      {/* Chart Section Header & Controls */}
      <div className="card-header" style={{ marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div className="card-header-title">
          <TrendingUp size={18} color="#f97316" />
          <span>Real-Time Environmental Trendlines (Pure SVG Engine)</span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 400 }}>
            {readings.length} actual points from SQLite
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {/* Time Window Selector (1h vs 24h) */}
          <div style={{
            display: 'flex',
            background: 'var(--bg-main)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '6px',
            padding: '2px'
          }}>
            <button
              onClick={() => setTimeRange('1h')}
              className={`btn-pager ${timeRange === '1h' ? 'active' : ''}`}
              style={{
                padding: '0.25rem 0.65rem',
                fontSize: '0.75rem',
                border: 'none',
                background: timeRange === '1h' ? 'var(--card-bg)' : 'transparent',
                color: timeRange === '1h' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                fontWeight: timeRange === '1h' ? 600 : 400
              }}
            >
              Last 1 Hour
            </button>
            <button
              onClick={() => setTimeRange('24h')}
              className={`btn-pager ${timeRange === '24h' ? 'active' : ''}`}
              style={{
                padding: '0.25rem 0.65rem',
                fontSize: '0.75rem',
                border: 'none',
                background: timeRange === '24h' ? 'var(--card-bg)' : 'transparent',
                color: timeRange === '24h' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                fontWeight: timeRange === '24h' ? 600 : 400
              }}
            >
              Last 24 Hours
            </button>
          </div>

          <button
            onClick={fetchTrendData}
            disabled={isLoading}
            className="btn-secondary"
            style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem' }}
            title="Refresh trend charts"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="diagnostic-box danger" style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertTriangle size={15} />
            <span>Failed to load trendline history: {error}</span>
          </div>
        </div>
      )}

      {/* Tooltip Overlay if point hovered */}
      {hoveredPoint && (
        <div style={{
          background: 'rgba(15, 23, 42, 0.95)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '6px',
          padding: '0.35rem 0.65rem',
          fontSize: '0.75rem',
          fontFamily: 'var(--font-mono)',
          marginBottom: '0.5rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.75rem'
        }}>
          <span style={{ color: hoveredPoint.metricType === 'temperature' ? '#f97316' : '#38bdf8', fontWeight: 700 }}>
            {hoveredPoint.metricType === 'temperature' ? 'Temperature' : 'Humidity'}: {hoveredPoint.val} {hoveredPoint.unit}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>
            Recorded: {new Date(hoveredPoint.time).toLocaleTimeString()} ({new Date(hoveredPoint.time).toLocaleDateString()})
          </span>
          <span style={{ color: 'var(--text-muted)' }}>
            Node: {hoveredPoint.raw.device_id}
          </span>
        </div>
      )}

      {/* Grid of 2 Pure SVG Trend Charts */}
      <div className="trend-charts-grid">
        
        {/* Temperature Chart Card */}
        <div className="trend-chart-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Thermometer size={16} color="#f97316" />
              <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>Temperature Trendline</strong>
            </div>

            {tempStats && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Min: <strong style={{ color: 'var(--text-primary)' }}>{tempStats.min.toFixed(1)}°C</strong>
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Avg: <strong style={{ color: 'var(--text-primary)' }}>{tempStats.avg.toFixed(1)}°C</strong>
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Max: <strong style={{ color: '#ea580c' }}>{tempStats.max.toFixed(1)}°C</strong>
                </span>
                <span style={{ color: '#059669', background: 'rgba(5, 150, 105, 0.1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>
                  Latest: {tempStats.current.toFixed(1)}°C
                </span>
              </div>
            )}
          </div>

          {renderSvgChart('temperature')}
        </div>

        {/* Humidity Chart Card */}
        <div className="trend-chart-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Droplets size={16} color="#0284c7" />
              <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>Relative Humidity Trendline</strong>
            </div>

            {humStats && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', fontSize: '0.7rem', fontFamily: 'var(--font-mono)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Min: <strong style={{ color: 'var(--text-primary)' }}>{humStats.min.toFixed(1)}%</strong>
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Avg: <strong style={{ color: 'var(--text-primary)' }}>{humStats.avg.toFixed(1)}%</strong>
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Max: <strong style={{ color: '#0284c7' }}>{humStats.max.toFixed(1)}%</strong>
                </span>
                <span style={{ color: '#0284c7', background: 'rgba(2, 132, 199, 0.1)', padding: '0.15rem 0.4rem', borderRadius: '4px' }}>
                  Latest: {humStats.current.toFixed(1)}%
                </span>
              </div>
            )}
          </div>

          {renderSvgChart('humidity')}
        </div>

      </div>

      {/* Subtext info */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: '0.75rem',
        paddingTop: '0.5rem',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: '0.7rem',
        color: 'var(--text-muted)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <Info size={12} />
          <span>Real historical telemetry queried from SQLite local storage • Zero third-party charting libraries</span>
        </div>
        {lastFetchedAt && <span>Last sync: {lastFetchedAt}</span>}
      </div>
    </div>
  );
}
