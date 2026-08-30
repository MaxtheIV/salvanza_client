import { useEffect, useMemo, useRef, useState } from 'react'
import { PulseIcon, CopyIcon, CloudArrowUpIcon } from '@phosphor-icons/react'
import { useTranslation } from '../i18n/i18nContext'

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 }
const FILTER_MIN = { all: 0, info: 1, warn: 2, error: 3 }

export function formatBytesShort(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(1)} ${units[i]}`
}

export function formatDuration(seconds) {
  if (seconds == null || seconds < 0 || !isFinite(seconds)) return null
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function phaseKey(phase) {
  switch (phase) {
    case 'connect': return 'activityPhaseConnect'
    case 'vss': return 'activityPhaseVss'
    case 'upload': return 'activityPhaseUpload'
    case 'finalize': return 'activityPhaseFinalize'
    case 'done': return 'activityPhaseDone'
    default: return null
  }
}

function outcomeKey(outcome, success) {
  switch (outcome) {
    case 'verified_success': return 'activityOutcomeSuccess'
    case 'success_with_policy_exclusions': return 'activityOutcomePolicy'
    case 'partial': return 'activityOutcomePartial'
    case 'failed': return 'activityOutcomeFailed'
    default: return success ? 'activityOutcomeSuccess' : 'activityOutcomeFailed'
  }
}

export default function ActivityPanel({ activity, onGoToBackup }) {
  const { t, tf } = useTranslation()
  const { run, stats, log, dropped } = activity
  const [filter, setFilter] = useState('info')
  const [autoscroll, setAutoscroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const paneRef = useRef(null)
  const pinnedRef = useRef(true)

  const visibleLog = useMemo(() => {
    const min = FILTER_MIN[filter] ?? 0
    return log.filter((e) => (LEVEL_RANK[e.level] ?? 1) >= min)
  }, [log, filter])

  // Keep the pane pinned to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = paneRef.current
    if (!el || !autoscroll || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [visibleLog, autoscroll])

  const onScroll = () => {
    const el = paneRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
  }

  const jumpToEnd = () => {
    pinnedRef.current = true
    const el = paneRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const copyLog = async () => {
    const text = visibleLog.map((e) => `${e.ts}  ${e.level.toUpperCase().padEnd(5)}  ${e.msg}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (_) { /* clipboard unavailable in this webview: nothing to do */ }
  }

  if (!run) {
    return (
      <div className="activity-empty">
        <PulseIcon size={28} />
        <p>{t('activityEmpty')}</p>
        <button type="button" className="btn" onClick={onGoToBackup}>
          <CloudArrowUpIcon size={15} />{t('activityGoToBackup')}
        </button>
      </div>
    )
  }

  const s = stats || run.stats || {}
  const running = run.running
  const percent = Math.round((s.percent || 0) * 100)
  const indeterminate = running && s.indeterminate
  const pk = phaseKey(s.phase)
  const eta = running ? formatDuration(s.eta_seconds >= 0 ? s.eta_seconds : null) : null
  const elapsed = formatDuration(s.elapsed_seconds)
  const totalChunks = (s.new_chunks || 0) + (s.reused_chunks || 0)
  const dedup = totalChunks > 0 ? Math.round((s.reused_chunks / totalChunks) * 100) : null
  const barClass = `progress-bar${indeterminate ? ' indeterminate' : ''}${run.complete && !run.success ? ' failed' : ''}`

  return (
    <div className="activity">
      <div className="activity-head">
        <div>
          <span className="activity-id">{run.backup_id || t('activityUnknown')}</span>
          <span className="muted"> → {run.target}</span>
        </div>
        <span className={`state ${run.complete ? (run.success ? 'state-ok' : 'state-bad') : 'state-busy'}`}>
          {run.complete
            ? t(outcomeKey(run.outcome, run.success))
            : (indeterminate ? t('activityScanning') : (pk ? t(pk) : t('activityUnknown')))}
        </span>
      </div>

      <div className="progress progress-lg">
        <div className={barClass} style={{ width: indeterminate ? '100%' : `${percent}%` }} />
      </div>
      <div className="progress-meta">
        <span className="progress-pct">{indeterminate ? t('activityUnknown') : `${percent}%`}</span>
        {s.dir_count > 1 && (
          <span>{tf('activityDirOf', { i: s.dir_index || 0, n: s.dir_count })}</span>
        )}
      </div>

      <div className="activity-tiles">
        <div className="tile"><span className="tile-label">{t('activityEta')}</span><span className="tile-value">{eta || t('activityUnknown')}</span></div>
        <div className="tile"><span className="tile-label">{t('activityElapsed')}</span><span className="tile-value">{elapsed || t('activityUnknown')}</span></div>
        <div className="tile"><span className="tile-label">{t('activitySpeed')}</span><span className="tile-value">{running && s.bytes_per_sec > 0 ? `${formatBytesShort(s.bytes_per_sec)}/s` : t('activityUnknown')}</span></div>
        <div className="tile"><span className="tile-label">{t('activityFiles')}</span><span className="tile-value">{(s.files_done || 0).toLocaleString()}</span></div>
        <div className="tile"><span className="tile-label">{t('activityData')}</span><span className="tile-value">{formatBytesShort(s.bytes_done)}{s.bytes_total > 0 ? ` / ${formatBytesShort(s.bytes_total)}` : ''}</span></div>
        <div className="tile"><span className="tile-label">{t('activityChunks')}</span><span className="tile-value">
          {s.new_chunks || 0} {t('activityChunksNew')} · {s.reused_chunks || 0} {t('activityChunksReused')}
          {s.failed_chunks > 0 && <span className="state state-bad"> {s.failed_chunks} {t('activityChunksFailed')}</span>}
        </span></div>
        <div className="tile"><span className="tile-label">{t('activityDedup')}</span><span className="tile-value">{dedup != null ? `${dedup}%` : t('activityUnknown')}</span></div>
      </div>

      {running && s.current_file && (
        <p className="form-hint mono activity-current" title={s.current_file}>
          {t('activityCurrent')}: {s.current_file}
        </p>
      )}

      <div className="activity-log">
        <div className="activity-log-bar">
          <strong>{t('activityLog')}</strong>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('activityLog')}>
            <option value="all">{t('activityFilterAll')}</option>
            <option value="info">{t('activityFilterInfo')}</option>
            <option value="warn">{t('activityFilterWarn')}</option>
            <option value="error">{t('activityFilterError')}</option>
          </select>
          <label className="check">
            <input type="checkbox" checked={autoscroll} onChange={(e) => { setAutoscroll(e.target.checked); if (e.target.checked) jumpToEnd() }} />
            <span className="check-label">{t('activityAutoscroll')}</span>
          </label>
          <button type="button" className="btn btn-sm" onClick={copyLog}>
            <CopyIcon size={13} />{copied ? t('activityCopied') : t('activityCopy')}
          </button>
        </div>
        <div className="log-pane" ref={paneRef} onScroll={onScroll}>
          {dropped && <div className="log-line muted">{t('activityOlderDropped')}</div>}
          {visibleLog.map((e) => (
            <div key={e.seq} className={`log-line ${e.level}`}>
              <span className="log-ts">{e.ts.slice(11, 19)}</span>
              <span className="log-level">{e.level.toUpperCase()}</span>
              <span className="log-msg">{e.msg}</span>
            </div>
          ))}
        </div>
        {autoscroll && !pinnedRef.current && (
          <button type="button" className="btn btn-sm log-jump" onClick={jumpToEnd}>{t('activityNewLines')}</button>
        )}
      </div>
    </div>
  )
}
