import { useState, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  ClockIcon,
  CloudArrowUpIcon,
  DatabaseIcon,
  DownloadSimpleIcon,
  FileIcon,
  FloppyDiskIcon,
  FolderIcon,
  FolderOpenIcon,
  InfoIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  PulseIcon,
  ShieldCheckIcon,
  StarIcon,
  StopIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useTranslation } from './i18n/i18nContext'
import ActivityPanel from './components/ActivityPanel'
import LanguageSwitcher from './components/LanguageSwitcher'
import ThemeToggle from './components/ThemeToggle'
// Bundled rather than fetched from nimbus.rdem-systems.com: this is a desktop
// app that must render identically with no network, and the About screen should
// not phone home just to draw a logo.
import logoUrl from './assets/logo.webp'

// Wails runtime imports (will be available when built with Wails)
let GetConfigWithHostname, SaveConfig, TestConnection, StartBackup, ListSnapshots, ListSnapshotContents, GetSnapshotMeta, RestoreSnapshot, OpenRestoreDestDialog, ListPhysicalDisks, GetVersion, EventsOn, SearchFiles, CancelSearch
let SaveScheduledJob, UpdateScheduledJob, GetScheduledJobs, DeleteScheduledJob, GetJobHistory, GetSystemInfo, GetLastBackupDirs
// Multi-PBS functions
let ListPBSServers, GetPBSServer, AddPBSServer, UpdatePBSServer, DeletePBSServer, SetDefaultPBSServer, GetDefaultPBSID, TestPBSConnection
let GetServerFingerprint, PinPBSServerFingerprint
// Activity tab: current run snapshot + its ring-buffered log
let GetActivity, GetActivityLog

// Check if we're running in Wails
if (window.go) {
  GetConfigWithHostname = window.go.main.App.GetConfigWithHostname
  SaveConfig = window.go.main.App.SaveConfig
  TestConnection = window.go.main.App.TestConnection
  StartBackup = window.go.main.App.StartBackup
  ListSnapshots = window.go.main.App.ListSnapshots
  ListSnapshotContents = window.go.main.App.ListSnapshotContents
  GetSnapshotMeta = window.go.main.App.GetSnapshotMeta
  RestoreSnapshot = window.go.main.App.RestoreSnapshot
  OpenRestoreDestDialog = window.go.main.App.OpenRestoreDestDialog
  SearchFiles = window.go.main.App.SearchFiles
  CancelSearch = window.go.main.App.CancelSearch
  ListPhysicalDisks = window.go.main.App.ListPhysicalDisks
  GetVersion = window.go.main.App.GetVersion
  SaveScheduledJob = window.go.main.App.SaveScheduledJob
  UpdateScheduledJob = window.go.main.App.UpdateScheduledJob
  GetScheduledJobs = window.go.main.App.GetScheduledJobs
  DeleteScheduledJob = window.go.main.App.DeleteScheduledJob
  GetJobHistory = window.go.main.App.GetJobHistory
  GetSystemInfo = window.go.main.App.GetSystemInfo
  GetLastBackupDirs = window.go.main.App.GetLastBackupDirs
  // Multi-PBS
  ListPBSServers = window.go.main.App.ListPBSServers
  GetPBSServer = window.go.main.App.GetPBSServer
  AddPBSServer = window.go.main.App.AddPBSServer
  UpdatePBSServer = window.go.main.App.UpdatePBSServer
  DeletePBSServer = window.go.main.App.DeletePBSServer
  SetDefaultPBSServer = window.go.main.App.SetDefaultPBSServer
  GetDefaultPBSID = window.go.main.App.GetDefaultPBSID
  TestPBSConnection = window.go.main.App.TestPBSConnection
  GetServerFingerprint = window.go.main.App.GetServerFingerprint
  PinPBSServerFingerprint = window.go.main.App.PinPBSServerFingerprint
  GetActivity = window.go.main.App.GetActivity
  GetActivityLog = window.go.main.App.GetActivityLog
}

// Wails events
if (window.runtime) {
  EventsOn = window.runtime.EventsOn
}

// Activity tab state. One reducer so a new run atomically resets log + stats,
// whether the run was started here (standalone events) or observed via the
// service poller (late join).
const initialActivity = { run: null, stats: null, log: [], nextSeq: 0, dropped: false }

// Keep the visible log bounded: a long backup can emit far more lines than a
// scrollback pane is worth, and every entry is retained in React state.
const MAX_LOG_ENTRIES = 2000

function activityReducer(state, action) {
  switch (action.type) {
    case 'run': {
      const run = action.run
      if (!run || !run.run_id) return state
      if (!state.run || state.run.run_id !== run.run_id) {
        return { run, stats: run.stats || null, log: [], nextSeq: 0, dropped: false }
      }
      return { ...state, run, stats: run.stats || state.stats }
    }
    case 'stats':
      return state.run ? { ...state, stats: action.stats } : state
    // The backend stopped answering while it was reporting a running backup. We
    // will never see this run's terminal event, so close it here rather than
    // leaving the panel spinning forever, and record why in the log pane. The
    // message is passed in already translated (no UI strings in the reducer).
    case 'lost': {
      if (!state.run || !state.run.running) return state
      const entry = { seq: state.nextSeq, ts: new Date().toISOString(), level: 'error', msg: action.message }
      return {
        ...state,
        run: { ...state.run, running: false, complete: true, success: false, message: action.message },
        log: state.log.concat(entry).slice(-MAX_LOG_ENTRIES),
        nextSeq: state.nextSeq + 1,
      }
    }
    case 'log': {
      const entries = action.entries || []
      if (!entries.length) return state
      // Merge by seq rather than trusting arrival order: at a run boundary the
      // standalone sinks and the service poller can both be feeding us, so
      // batches arrive concurrently and out of order. Dropping everything below
      // nextSeq would silently lose a late batch that overlaps a newer one.
      const prevLast = state.log.length ? state.log[state.log.length - 1].seq : -1
      const merged = state.log.concat(entries).sort((a, b) => a.seq - b.seq)
      const deduped = []
      for (const e of merged) {
        // The sort puts equal seqs next to each other, so one look-back dedupes.
        if (deduped.length && deduped[deduped.length - 1].seq === e.seq) continue
        deduped.push(e)
      }
      const log = deduped.slice(-MAX_LOG_ENTRIES)
      // "dropped" drives the "older entries dropped" banner. It is sticky: a gap
      // relative to what we already hold means the backend ring buffer wrapped
      // past us, and trimming to MAX_LOG_ENTRIES drops old lines ourselves.
      const dropped = state.dropped ||
        (state.log.length > 0 && entries[0].seq > prevLast + 1) ||
        deduped.length > MAX_LOG_ENTRIES
      return { ...state, log, nextSeq: log[log.length - 1].seq + 1, dropped }
    }
    default:
      return state
  }
}

function App() {
  const { t, tf } = useTranslation()
  const [activeTab, setActiveTab] = useState('servers')
  const [hostname, setHostname] = useState('')
  const [appVersion, setAppVersion] = useState('dev')
  const [systemInfo, setSystemInfo] = useState({ mode: 'Standalone', is_admin: false, service_available: false, os: '' })
  const [config, setConfig] = useState({
    baseurl: '',
    certfingerprint: '',
    authid: '',
    secret: '',
    datastore: '',
    namespace: '',
    backupdir: '',
    'backup-id': '',
    usevss: true
  })

  // Multi-PBS states
  const [pbsServers, setPbsServers] = useState([])
  const [defaultPBSID, setDefaultPBSID] = useState('')
  const [selectedPBSID, setSelectedPBSID] = useState('')
  const [editingServer, setEditingServer] = useState(null)
  const [serverFormData, setServerFormData] = useState({
    id: '',
    name: '',
    baseurl: '',
    certfingerprint: '',
    authid: '',
    secret: '',
    datastore: '',
    namespace: '',
    description: ''
  })
  const [serverStatus, setServerStatus] = useState({}) // Map of server ID -> connection status

  const [backupType, setBackupType] = useState('directory')
  const [backupDirs, setBackupDirs] = useState('')
  const [selectedDrives, setSelectedDrives] = useState([])
  const [physicalDisks, setPhysicalDisks] = useState([])
  const [excludeList, setExcludeList] = useState('')
  const [progress, setProgress] = useState(0)
  // Opt-in: split this backup into parts (for the first backup of a large volume).
  // Off by default → no size analysis, the backup starts immediately.
  const [splitFirstBackup, setSplitFirstBackup] = useState(false)

  // Scheduling states
  const [backupMode, setBackupMode] = useState('oneshot') // 'oneshot' or 'scheduled'
  const [scheduleTime, setScheduleTime] = useState('02:00')
  const [runAtStartup, setRunAtStartup] = useState(false)
  const [scheduledJobs, setScheduledJobs] = useState([])
  const [jobHistory, setJobHistory] = useState([])
  const [editingJobId, setEditingJobId] = useState(null) // Track which job is being edited
  const [activity, dispatchActivity] = useReducer(activityReducer, initialActivity)
  // Last run id seen on an activity:run event, so a genuinely new run — and only
  // a new run — may reset the monotonic percent (C-2).
  const lastRunIdRef = useRef(null)
  // The backup-events effect subscribes once ([] deps); capturing t directly would
  // freeze the "lost contact" line in whichever language the app started in.
  const tRef = useRef(t)
  tRef.current = t
  const [status, setStatus] = useState({ message: '', type: '', visible: false })

  const [snapshots, setSnapshots] = useState([])
  const [restoreBackupId, setRestoreBackupId] = useState('')
  const [showSnapshots, setShowSnapshots] = useState(false)
  const [restorePBSID, setRestorePBSID] = useState('')
  const [selectedSnapshot, setSelectedSnapshot] = useState(null) // { id, unix, time }
  const [snapshotMeta, setSnapshotMeta] = useState(null)         // .nimbus_backup_meta.json sidecar (null if legacy)
  const [snapshotEntries, setSnapshotEntries] = useState([])     // flat list from backend
  const [expandedDirs, setExpandedDirs] = useState(new Set())     // expanded paths in tree
  const [selectedPaths, setSelectedPaths] = useState(new Set())   // selected entry paths
  const [restoreDestPath, setRestoreDestPath] = useState('')
  // 'original' (in-place), 'alternate_abs' (preserve tree), 'alternate_flat' (strip prefix)
  const [restoreMode, setRestoreMode] = useState('alternate_abs')
  const [restoreAllowCrossHost, setRestoreAllowCrossHost] = useState(false)
  // alternate sub-mode toggle: true = abs (keep tree), false = flat. Default flat per spec.
  const [restoreKeepTree, setRestoreKeepTree] = useState(false)
  const [restoreOptions, setRestoreOptions] = useState({
    overwrite: false,
    timestamps: true,
    acls: false, // disabled in UI until NTFS sidecar lands
    ads: false   // disabled in UI until NTFS sidecar lands
  })
  const [restoreLoading, setRestoreLoading] = useState(false)
  const [restoreProgress, setRestoreProgress] = useState(0)

  // ===== file search across snapshots =====
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState('name')      // 'name' | 'regex' | 'path'
  const [searchFrom, setSearchFrom] = useState('')           // yyyy-mm-dd
  const [searchTo, setSearchTo] = useState('')               // yyyy-mm-dd
  const [searchAssembleMissing, setSearchAssembleMissing] = useState(false)
  const [searchRunning, setSearchRunning] = useState(false)
  const [searchProgress, setSearchProgress] = useState({ percent: 0, message: '' })
  const [searchResult, setSearchResult] = useState(null)     // { hits, snapshots_*, truncated, cancelled }

  // Update restoreBackupId when config or hostname changes
  useEffect(() => {
    if (!restoreBackupId && (config['backup-id'] || hostname)) {
      setRestoreBackupId(config['backup-id'] || hostname)
    }
  }, [config['backup-id'], hostname])

  // When the selected snapshot has no sidecar (legacy) or its OS doesn't match
  // the current host, in-place is impossible. Snap the mode back to alternate
  // so a stale "original" selection doesn't survive across snapshot switches.
  useEffect(() => {
    if (restoreMode !== 'original') return
    if (!snapshotMeta) { setRestoreMode('alternate_abs'); return }
    if (!snapshotMeta.original_path) { setRestoreMode('alternate_abs'); return }
    if (systemInfo.os && snapshotMeta.os && systemInfo.os !== snapshotMeta.os) {
      setRestoreMode('alternate_abs')
    }
  }, [snapshotMeta, systemInfo.os, restoreMode])

  // Sync restore PBS dropdown with default once it's loaded
  useEffect(() => {
    if (!restorePBSID && defaultPBSID) {
      setRestorePBSID(defaultPBSID)
    }
  }, [defaultPBSID])

  // Load physical disks when switching to machine mode (DISABLED FOR NOW)
  /*
  useEffect(() => {
    if (backupType === 'machine' && ListPhysicalDisks && physicalDisks.length === 0) {
      ListPhysicalDisks().then(disks => {
        setPhysicalDisks(disks)
        // Select first disk by default
        if (disks.length > 0 && selectedDrives.length === 0) {
          setSelectedDrives([disks[0].path])
        }
      }).catch(err => {
        showStatus(`${t('statusDiskError')} ${err}`, 'error')
      })
    }
  }, [backupType])
  */

  // Listen to backup events
  useEffect(() => {
    if (!EventsOn) return

    const unsubProgress = EventsOn('backup:progress', (data) => {
      // Monotonic within a run: the engine legitimately reports 0 % during the
      // indeterminate window (the folder size scan is still running) and, in
      // service mode, /backup/status reports 0 for the whole run. Letting the bar
      // fall back to 0 used to look like the backup had restarted (C-2).
      setProgress((p) => Math.max(p, Math.round(data.percent)))
      showStatus(data.message, 'info', false)
    })

    // The Activity tab is driven entirely by the tracker: the run snapshot, the
    // structured stats emitted alongside progress, and the run log.
    const unsubRun = EventsOn('activity:run', (snap) => {
      // A new run id is the only thing that may take the bar backwards.
      if (snap && snap.run_id && lastRunIdRef.current !== snap.run_id) {
        lastRunIdRef.current = snap.run_id
        setProgress(0)
      }
      dispatchActivity({ type: 'run', run: snap })
    })
    const unsubStats = EventsOn('backup:stats', (stats) => dispatchActivity({ type: 'stats', stats }))
    const unsubLog = EventsOn('backup:log', (data) => dispatchActivity({ type: 'log', entries: data.entries }))
    // The service stopped answering /activity while a backup was running: close
    // the run in the panel instead of spinning forever (spec §4).
    const unsubLost = EventsOn('activity:lost', () => dispatchActivity({ type: 'lost', message: tRef.current('activityLostContact') }))

    const unsubComplete = EventsOn('backup:complete', (data) => {
      setProgress(data.success ? 100 : 0)
      showStatus(data.message, data.success ? 'success' : 'error')

      // Add to job history
      const historyEntry = {
        id: Date.now().toString(),
        name: `Backup ${config['backup-id'] || hostname}`,
        timestamp: new Date().toISOString(),
        status: data.success ? 'success' : 'failed',
        message: data.message,
        backupDirs: backupDirs.split('\n').map(d => d.trim()).filter(d => d),
        backupId: config['backup-id'] || hostname,
        useVSS: config.usevss
      }
      setJobHistory(prev => [historyEntry, ...prev].slice(0, 20)) // Keep last 20 entries
    })

    // Late join / reopen: prime from the backend so a run started by the
    // scheduler (service mode) or before this component mounted is visible.
    ;(async () => {
      try {
        if (!GetActivity) return
        const snap = await GetActivity()
        if (snap && snap.run_id) {
          dispatchActivity({ type: 'run', run: snap })
          if (GetActivityLog) {
            const lg = await GetActivityLog(0)
            dispatchActivity({ type: 'log', entries: lg && lg.entries })
          }
        }
      } catch (_) { /* no backend (vite dev) */ }
    })()

    return () => {
      if (unsubProgress) unsubProgress()
      if (unsubRun) unsubRun()
      if (unsubStats) unsubStats()
      if (unsubLog) unsubLog()
      if (unsubLost) unsubLost()
      if (unsubComplete) unsubComplete()
    }
  }, [])

  // Listen to restore events
  useEffect(() => {
    if (!EventsOn) return
    const unsubP = EventsOn('restore:progress', (data) => {
      setRestoreProgress(Math.round((data.percent || 0) * 100))
      showStatus(data.message || '', 'info', false)
    })
    const unsubC = EventsOn('restore:complete', (data) => {
      setRestoreLoading(false)
      setRestoreProgress(data.success ? 100 : 0)
      showStatus(data.message, data.success ? 'success' : 'error')
    })
    return () => {
      if (unsubP) unsubP()
      if (unsubC) unsubC()
    }
  }, [])

  // Listen to search progress
  useEffect(() => {
    if (!EventsOn) return
    const unsub = EventsOn('search:progress', (data) => {
      setSearchProgress({ percent: Math.round((data.percent || 0) * 100), message: data.message || '' })
    })
    return () => { if (unsub) unsub() }
  }, [])

  // Split size-analysis progress (explicit-split path only) — folder-by-folder so
  // a multi-minute scan of a large volume shows movement instead of a frozen spinner.
  useEffect(() => {
    if (!EventsOn) return
    const unsub = EventsOn('analysis:progress', (data) => {
      const done = data.done || 0
      const total = data.total || 0
      const gb = ((data.bytes || 0) / (1024 * 1024 * 1024)).toFixed(1)
      showStatus(`${t('splitAnalyzing')} ${done}/${total} (${gb} GB)`, 'info', false)
    })
    return () => { if (unsub) unsub() }
  }, [])

  // Load config with hostname on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        // Load version
        if (GetVersion) {
          const version = await GetVersion()
          setAppVersion(version || 'dev')
        }

        // Load system info (mode, admin status, service availability)
        if (GetSystemInfo) {
          const sysInfo = await GetSystemInfo()
          setSystemInfo(sysInfo || { mode: 'Standalone', is_admin: false, service_available: false })
        }

        // Load last backup directories to pre-fill the form
        if (GetLastBackupDirs) {
          const lastDirs = await GetLastBackupDirs()
          if (lastDirs && lastDirs.length > 0) {
            setBackupDirs(lastDirs.join('\n'))
          }
        }

        if (GetConfigWithHostname) {
          const data = await GetConfigWithHostname()
          if (data) {
            // Extract hostname
            const hn = data.hostname || ''
            setHostname(hn)

            // Set config (hostname is already in backup-id if needed)
            setConfig({
              baseurl: data.baseurl || '',
              certfingerprint: data.certfingerprint || '',
              authid: data.authid || '',
              secret: data.secret || '',
              datastore: data.datastore || '',
              namespace: data.namespace || '',
              backupdir: data.backupdir || '',
              'backup-id': data['backup-id'] || hn,
              usevss: data.usevss !== undefined ? data.usevss : true
            })

            // Initialize backupDirs from config if available
            if (data.backupdir) {
              setBackupDirs(data.backupdir)
            }
          }
        }
      } catch (err) {
        console.error('Failed to load config:', err)
      }
    }

    loadData()
  }, [])

  // Load scheduled jobs and history on mount
  useEffect(() => {
    const loadSchedulerData = async () => {
      try {
        if (GetScheduledJobs) {
          const jobs = await GetScheduledJobs()
          setScheduledJobs(jobs || [])
        }

        if (GetJobHistory) {
          const history = await GetJobHistory()
          setJobHistory(history || [])
        }
      } catch (err) {
        console.error('Failed to load scheduler data:', err)
      }
    }

    loadSchedulerData()

    // Refresh history every 10 seconds to update status of running jobs
    const intervalId = setInterval(() => {
      if (GetJobHistory) {
        GetJobHistory().then(history => {
          setJobHistory(history || [])
        }).catch(err => {
          console.error('Failed to refresh job history:', err)
        })
      }
    }, 10000) // 10 seconds

    return () => clearInterval(intervalId)
  }, [])

  // Load PBS servers on mount
  useEffect(() => {
    const loadPBSServers = async () => {
      try {
        if (ListPBSServers) {
          const servers = await ListPBSServers()
          setPbsServers(servers || [])
        }

        if (GetDefaultPBSID) {
          const defaultID = await GetDefaultPBSID()
          setDefaultPBSID(defaultID || '')
          setSelectedPBSID(defaultID || '')
        }
      } catch (err) {
        console.error('Failed to load PBS servers:', err)
      }
    }

    loadPBSServers()
  }, [])

  // Single shared auto-hide timer for the status bar. Progress events fire
  // continuously during a backup/restore; without coalescing, every call queued
  // its own 5s timeout and a stale one would hide the bar mid-run (the bar
  // "jumping" in and out at the bottom of the page). We now clear the previous
  // timer on each call, and callers pass autoHide=false for continuous progress
  // so the bar stays put until it is replaced or the operation completes.
  const statusTimerRef = useRef(null)
  const showStatus = (message, type, autoHide = true) => {
    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = null
    }
    setStatus({ message, type, visible: true })
    if (autoHide) {
      statusTimerRef.current = setTimeout(() => {
        setStatus(s => ({ ...s, visible: false }))
        statusTimerRef.current = null
      }, 5000)
    }
  }

  // ==================== MULTI-PBS HANDLERS ====================

  const loadPBSServers = async () => {
    try {
      if (ListPBSServers) {
        const servers = await ListPBSServers()
        setPbsServers(servers || [])
      }
      if (GetDefaultPBSID) {
        const defaultID = await GetDefaultPBSID()
        setDefaultPBSID(defaultID || '')
      }
    } catch (err) {
      console.error('Failed to load PBS servers:', err)
      showStatus(`${t('statusServerLoadError')} ${err}`, 'error')
    }
  }

  const handleAddPBSServer = async () => {
    if (!AddPBSServer) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }

    try {
      // Generate ID from name if not provided
      if (!serverFormData.id) {
        serverFormData.id = serverFormData.name.toLowerCase().replace(/[^a-z0-9]/g, '-')
      }

      await AddPBSServer(serverFormData)
      showStatus(`${t('statusServerAdded')}`, 'success')

      // Reset form and reload
      setServerFormData({
        id: '',
        name: '',
        baseurl: '',
        certfingerprint: '',
        authid: '',
        secret: '',
        datastore: '',
        namespace: '',
        description: ''
      })
      setEditingServer(null)
      await loadPBSServers()
    } catch (err) {
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  const handleUpdatePBSServer = async () => {
    if (!UpdatePBSServer) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }

    try {
      await UpdatePBSServer(serverFormData)
      showStatus(`${t('statusServerUpdated')}`, 'success')

      // Reset form and reload
      setServerFormData({
        id: '',
        name: '',
        baseurl: '',
        certfingerprint: '',
        authid: '',
        secret: '',
        datastore: '',
        namespace: '',
        description: ''
      })
      setEditingServer(null)
      await loadPBSServers()
    } catch (err) {
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  const handleDeletePBSServer = async (id) => {
    if (!DeletePBSServer) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }

    if (!confirm(t('confirmDeleteServer').replace('{id}', id))) {
      return
    }

    try {
      await DeletePBSServer(id)
      showStatus(`${t('statusServerDeleted')}`, 'success')
      await loadPBSServers()
    } catch (err) {
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  const handleSetDefaultPBS = async (id) => {
    if (!SetDefaultPBSServer) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }

    try {
      await SetDefaultPBSServer(id)
      setDefaultPBSID(id)
      showStatus(`${t('statusServerSetDefault').replace('{id}', id)}`, 'success')
    } catch (err) {
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  // True when a connection failure is an unverified-certificate error (self-signed
  // PBS with no fingerprint pinned). These are recoverable via trust-on-first-use.
  const isCertError = (err) =>
    /certificate signed by unknown authority|failed to verify certificate|x509/i.test(String(err))

  const handleTestPBSConnection = async (id) => {
    if (!TestPBSConnection) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }

    try {
      setServerStatus(prev => ({ ...prev, [id]: 'testing' }))
      await TestPBSConnection(id)
      setServerStatus(prev => ({ ...prev, [id]: 'online' }))
      showStatus(`${t('statusConnectionSuccess').replace('{id}', id)}`, 'success')
    } catch (err) {
      const server = pbsServers.find(s => s.id === id)
      // Self-signed cert + no fingerprint yet: offer to discover and pin it (TOFU).
      if (isCertError(err) && server && !(server.certfingerprint || '').trim() &&
          GetServerFingerprint && PinPBSServerFingerprint) {
        try {
          const fp = await GetServerFingerprint(server.baseurl)
          if (window.confirm(t('tofuConfirm').replace('{host}', server.baseurl).replace('{fp}', fp))) {
            await PinPBSServerFingerprint(id, fp)
            await loadPBSServers()
            await TestPBSConnection(id)
            setServerStatus(prev => ({ ...prev, [id]: 'online' }))
            showStatus(`${t('statusFingerprintPinned')}`, 'success')
            return
          }
        } catch (fpErr) {
          showStatus(`${t('statusFingerprintFailed')} ${fpErr}`, 'error')
          setServerStatus(prev => ({ ...prev, [id]: 'offline' }))
          return
        }
      }
      setServerStatus(prev => ({ ...prev, [id]: 'offline' }))
      showStatus(`${t('statusConnectionFailed')} ${err}`, 'error')
    }
  }

  const handleEditServer = (server) => {
    setServerFormData(server)
    setEditingServer(server.id)
  }

  const handleCancelEdit = () => {
    setServerFormData({
      id: '',
      name: '',
      baseurl: '',
      certfingerprint: '',
      authid: '',
      secret: '',
      datastore: '',
      namespace: '',
      description: ''
    })
    setEditingServer(null)
  }

  // ==================== END MULTI-PBS HANDLERS ====================

  const handleSaveConfig = async () => {
    if (!SaveConfig) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }

    try {
      // Trim all string values to remove whitespace (with safe fallback for undefined)
      const trimmedConfig = {
        baseurl: (config.baseurl || '').trim(),
        certfingerprint: (config.certfingerprint || '').trim(),
        authid: (config.authid || '').trim(),
        secret: (config.secret || '').trim(),
        datastore: (config.datastore || '').trim(),
        namespace: (config.namespace || '').trim(),
        backupdir: (config.backupdir || '').trim(),
        'backup-id': (config['backup-id'] || '').trim() || hostname, // Use hostname if empty
        usevss: config.usevss !== undefined ? config.usevss : true
      }
      await SaveConfig(trimmedConfig)
      setConfig(trimmedConfig)
      showStatus(`${t('statusConfigSaved')}`, 'success')
    } catch (err) {
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  const handleTestConnection = async () => {
    if (!TestConnection) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }

    // Test with current form values (no need to save first). Declared outside the
    // try so the TOFU retest in catch can reuse these already-normalized fields.
    const testConfig = {
      baseurl: (config.baseurl || '').trim(),
      certfingerprint: (config.certfingerprint || '').trim(),
      authid: (config.authid || '').trim(),
      secret: (config.secret || '').trim(),
      datastore: (config.datastore || '').trim(),
      namespace: (config.namespace || '').trim(),
      backupdir: (config.backupdir || '').trim(),
      'backup-id': (config['backup-id'] || '').trim() || hostname, // Use hostname if empty
      usevss: config.usevss !== undefined ? config.usevss : true
    }

    try {
      await TestConnection(testConfig)
      showStatus(`${t('statusConnectionOK')}`, 'success')
    } catch (err) {
      // Self-signed cert + no fingerprint yet: discover, re-test pinned, fill the
      // form so a Save persists it (legacy single-server config).
      if (isCertError(err) && !(config.certfingerprint || '').trim() && GetServerFingerprint) {
        try {
          const fp = await GetServerFingerprint((config.baseurl || '').trim())
          if (window.confirm(t('tofuConfirm').replace('{host}', config.baseurl).replace('{fp}', fp))) {
            // Reuse the already-normalized testConfig (trimmed fields) for the pinned retest.
            await TestConnection({ ...testConfig, certfingerprint: fp })
            setConfig(prev => ({ ...prev, certfingerprint: fp }))
            showStatus(`${t('statusFingerprintPinnedSave')}`, 'success')
            return
          }
        } catch (fpErr) {
          showStatus(`${t('statusFingerprintFailed')} ${fpErr}`, 'error')
          return
        }
      }
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  const handleLoadConfigFile = (e) => {
    const file = e.target.files[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const loadedConfig = JSON.parse(evt.target.result)
        setConfig(loadedConfig)
        showStatus(`${t('statusConfigLoaded')}`, 'success')
      } catch (err) {
        showStatus(`${t('statusInvalidJSON')}`, 'error')
      }
    }
    reader.readAsText(file)
  }

  // Execute split backup for large volumes (explicit opt-in via the split toggle).
  // CreateBackupSplitPlan runs the size analysis the user asked for (bounded, and
  // reporting folder-by-folder progress via the "analysis:progress" event) and
  // returns one job per part; we then run a backup per part.
  const executeSplitBackup = async (dirList) => {
    if (!window.go || !window.go.main.App.CreateBackupSplitPlan) {
      showStatus(t('errSplitUnavailable'), 'error')
      return
    }

    try {
      showStatus(t('splitAnalyzing'), 'info')
      const splitPlan = await window.go.main.App.CreateBackupSplitPlan(
        dirList,
        config['backup-id'] || hostname,
        excludeList.split('\n').filter(l => l.trim())
      )

      // If the analysis didn't yield a real split (volume below threshold, scan
      // incomplete, or splitting disabled), the single "job" only covers the
      // enumerated subfolders and would DROP files sitting directly under the
      // selected root. Fall back to a normal full backup of the roots, which
      // always captures everything.
      if (!splitPlan || splitPlan.length <= 1) {
        showStatus(`${t('statusBackupStarting')}`, 'info')
        setProgress(5)
        await StartBackup(
          backupType,
          dirList,
          selectedDrives,
          excludeList.split('\n').filter(l => l.trim()),
          config['backup-id'],
          config.usevss,
          ''
        )
        // Only now: a failed start throws, and the status banner is not rendered
        // on the panel the user would have been moved to (C-3).
        setActiveTab('activity')
        showStatus(`⏳ ${t('statusBackupRunning')}`, 'info')
        return
      }

      showStatus(tf('statusSplitLaunching', { n: splitPlan.length }), 'info')
      // The analysis produced a real plan, so parts are about to run: the live
      // view is now the useful one (C-3).
      setActiveTab('activity')

      // Arm a one-shot listener for the next backup:complete BEFORE starting a
      // part, so a fast completion can't be missed. The backend emits this event
      // in both standalone (OnComplete) and service mode (pollBackupProgress),
      // so awaiting it gives the part's REAL outcome instead of guessing success.
      const armBackupCompletion = () => {
        let unsub
        const promise = new Promise((resolve) => {
          unsub = EventsOn('backup:complete', (data) => {
            if (typeof unsub === 'function') unsub()
            resolve(data || { success: false, message: t('errCompletionNoData') })
          })
        })
        return { promise, cancel: () => { if (typeof unsub === 'function') unsub() } }
      }

      // Execute split jobs sequentially, waiting for each part's real outcome.
      let succeeded = 0
      const failures = []
      for (let i = 0; i < splitPlan.length; i++) {
        const job = splitPlan[i]
        showStatus(
          tf('statusSplitJobProgress', { i: job.index, n: job.total_jobs, size: job.size_fmt }),
          'info'
        )

        const completion = armBackupCompletion()
        try {
          await StartBackup(
            backupType,
            job.folders,
            selectedDrives,
            // Merge user exclusions with this job's own (a root-remainder job
            // excludes the subfolders already covered by other jobs — v2-H-01).
            [...excludeList.split('\n').filter(l => l.trim()), ...(job.exclude_list || [])],
            job.backup_id,
            config.usevss,
            ''
          )
        } catch (err) {
          // The part never started (validation / dispatch error): no completion
          // event will arrive, so cancel the wait and offer a retry.
          completion.cancel()
          const retry = window.confirm(
            tf('confirmSplitStartFailed', { i: job.index, n: job.total_jobs, err })
          )
          if (retry) { i--; continue }
          failures.push(tf('splitFailureStart', { i: job.index, err }))
          continue
        }

        // Wait for THIS part to actually finish before starting the next one.
        const result = await completion.promise
        if (result.success) {
          succeeded++
          showStatus(tf('statusSplitJobDone', { i: job.index, n: job.total_jobs }), 'success')
        } else {
          showStatus(
            tf('statusSplitJobFailed', { i: job.index, n: job.total_jobs, msg: result.message || '' }),
            'error'
          )
          const retry = window.confirm(
            tf('confirmSplitRetry', { i: job.index, n: job.total_jobs, msg: result.message || '' })
          )
          if (retry) { i--; continue }
          failures.push(tf('splitFailure', { i: job.index, msg: result.message || t('splitFailureGeneric') }))
        }
      }

      // Honest aggregate: only claim success when EVERY part actually succeeded.
      if (failures.length === 0) {
        showStatus(
          tf('statusBackupComplete', { done: succeeded, total: splitPlan.length }),
          'success'
        )
      } else {
        showStatus(
          tf('statusSplitPartial', { ok: succeeded, total: splitPlan.length, failed: failures.length }) +
          '\n' + failures.join('\n'),
          'error'
        )
      }
    } catch (err) {
      showStatus(`${t('statusSplitError')} ${err}`, 'error')
    }
  }

  const handleStartBackup = async () => {
    if (!StartBackup) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }

    // Parse backup directories (one per line)
    const dirList = backupDirs.split('\n').map(d => d.trim()).filter(d => d)

    if (backupType === 'directory' && dirList.length === 0) {
      showStatus(t('errDirRequired'), 'error')
      return
    }

    if (backupType === 'machine' && selectedDrives.length === 0) {
      showStatus(t('errDiskRequired'), 'error')
      return
    }

    // Splitting is now an explicit, opt-in choice (the "split this backup" toggle),
    // intended for the first backup of a large volume. When it's off we never size
    // the directories — the backup starts immediately, so a whole-drive root like
    // C:\ can no longer hang on the analysis. When it's on, executeSplitBackup runs
    // the (bounded, progress-reporting) size analysis the user asked for, then runs
    // one backup per part. Subsequent backups are left unsplit (full).
    if (splitFirstBackup && backupType === 'directory' && backupMode === 'oneshot') {
      await executeSplitBackup(dirList)
      return
    }

    // Scheduled mode - save or update job instead of executing immediately
    if (backupMode === 'scheduled') {
      if (!SaveScheduledJob || !UpdateScheduledJob) {
        showStatus(t('statusSchedulingUnavailable'), 'error')
        return
      }

      const jobData = {
        id: editingJobId || Date.now().toString(),
        name: `Backup ${config['backup-id'] || hostname}`,
        scheduleTime: scheduleTime,
        runAtStartup: runAtStartup,
        backupDirs: dirList,
        backupId: config['backup-id'],
        useVSS: config.usevss,
        backupType: backupType,
        excludeList: excludeList.split('\n').filter(l => l.trim())
      }

      // Save or update to backend
      try {
        if (editingJobId) {
          // Update existing job
          await UpdateScheduledJob(jobData)
          setScheduledJobs(scheduledJobs.map(j => j.id === editingJobId ? jobData : j))
          showStatus(tf('statusScheduleUpdated', { time: scheduleTime }), 'success')
          setEditingJobId(null)
        } else {
          // Create new job
          await SaveScheduledJob(jobData)
          setScheduledJobs([...scheduledJobs, jobData])
          showStatus(tf('statusScheduleSaved', { time: scheduleTime }), 'success')
        }
        // Reset form after save
        setScheduleTime('02:00')
        setRunAtStartup(false)
        setBackupDirs('')
      } catch (err) {
        showStatus(`${t('statusError')} ${err}`, 'error')
      }
      return
    }

    // One-shot mode - execute immediately
    showStatus(`${t('statusBackupStarting')}`, 'info')
    setProgress(5)

    try {
      await StartBackup(
        backupType,
        dirList,
        selectedDrives,
        excludeList.split('\n').filter(l => l.trim()),
        config['backup-id'],
        config.usevss,
        ''
      )
      // Live progress, stats and log all live on the Activity tab now — but only
      // switch once the start actually succeeded, otherwise the catch branch's
      // error banner would render on a panel the user just left (C-3).
      setActiveTab('activity')
      // Backup started in background - progress will be shown via events
      showStatus(`⏳ ${t('statusBackupRunning')}`, 'info')
    } catch (err) {
      setProgress(0)
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  const handleListSnapshots = async () => {
    if (!ListSnapshots) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }
    if (!restoreBackupId) {
      showStatus(t('errBackupIDRequired'), 'error')
      return
    }

    showStatus(t('statusSearchingSnapshots'), 'info')
    setSelectedSnapshot(null)
    setSnapshotEntries([])
    setSelectedPaths(new Set())
    setExpandedDirs(new Set())

    try {
      const snaps = await ListSnapshots(restorePBSID || '', restoreBackupId)
      setSnapshots(snaps || [])
      setShowSnapshots(true)
      showStatus(tf('statusSnapshotsFound', { n: snaps.length }), 'success')
    } catch (err) {
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  const handleSelectSnapshot = async (snap, forceRefresh = false) => {
    if (!ListSnapshotContents) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }
    setSelectedSnapshot(snap)
    setSnapshotMeta(null)
    setSnapshotEntries([])
    setSelectedPaths(new Set())
    setExpandedDirs(new Set())
    showStatus(`${t('loadingSnapshotContents')}`, 'info')
    const effectiveBackupId = snap.backup_id || restoreBackupId
    try {
      // Backend uses the snapshot's actual backup_id (snap.backup_id) so split
      // backups list their real contents, not the partial search term.
      const entries = await ListSnapshotContents(restorePBSID || '', effectiveBackupId, snap.unix, forceRefresh)
      setSnapshotEntries(entries || [])
      showStatus(`${(entries || []).length} ${t('entriesLoaded')}`, 'success')
    } catch (err) {
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
    // Meta is informational — fire-and-forget. The listing call above has
    // already populated the cache, so this is a cheap cache hit. Failure is
    // silent: legacy snapshots simply have no sidecar.
    if (GetSnapshotMeta) {
      try {
        const meta = await GetSnapshotMeta(restorePBSID || '', effectiveBackupId, snap.unix)
        if (meta) setSnapshotMeta(meta)
      } catch (_err) {
        // ignored — banner stays hidden
      }
    }
  }

  const handleReloadSnapshot = async () => {
    if (!selectedSnapshot) return
    await handleSelectSnapshot(selectedSnapshot, true)
  }

  const handleBrowseRestoreDest = async () => {
    if (!OpenRestoreDestDialog) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }
    try {
      const dir = await OpenRestoreDestDialog()
      if (dir) setRestoreDestPath(dir)
    } catch (err) {
      // In service mode the native picker is unavailable by design — guide the
      // user to the manual path field instead of flagging it as a failure.
      showStatus(`${err}`, 'info')
    }
  }

  // ===== file search handlers =====

  // Convert a yyyy-mm-dd local date string to Unix seconds. endOfDay pushes to
  // 23:59:59 so the "To" bound is inclusive of the whole day. "" → 0 (open).
  const parseDateToUnix = (s, endOfDay = false) => {
    if (!s) return 0
    const [y, m, d] = s.split('-').map(Number)
    if (!y || !m || !d) return 0
    const dt = endOfDay ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0)
    return Math.floor(dt.getTime() / 1000)
  }

  const handleSearch = async () => {
    if (!SearchFiles) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }
    if (!searchQuery.trim()) {
      showStatus('' + t('searchQueryRequired'), 'error')
      return
    }
    const prefix = (restoreBackupId || hostname || '').trim()
    setSearchRunning(true)
    setSearchResult(null)
    setSearchProgress({ percent: 0, message: '' })
    try {
      const res = await SearchFiles(
        restorePBSID || '',
        prefix,
        searchQuery,
        searchMode,
        parseDateToUnix(searchFrom, false),
        parseDateToUnix(searchTo, true),
        searchAssembleMissing
      )
      setSearchResult(res)
      const n = (res && res.hits) ? res.hits.length : 0
      showStatus(`${t('searchDone').replace('{n}', n)}`, 'success')
    } catch (err) {
      showStatus(`${t('statusError')} ${err}`, 'error')
    } finally {
      setSearchRunning(false)
    }
  }

  const handleCancelSearch = () => {
    if (CancelSearch) {
      try { CancelSearch() } catch (_e) { /* best effort */ }
    }
  }

  // Pre-fill the restore form from a search hit: select the hit's snapshot,
  // load its contents, and tick the matched entry.
  const handleRestoreHit = async (hit) => {
    setRestoreBackupId(hit.backup_id)
    const iso = new Date(hit.snapshot_time * 1000).toISOString()
    const snap = {
      id: iso.slice(0, 19) + 'Z',
      backup_id: hit.backup_id,
      unix: hit.snapshot_time,
      time: new Date(hit.snapshot_time * 1000).toLocaleString(),
    }
    setShowSnapshots(true)
    await handleSelectSnapshot(snap)
    setSelectedPaths(new Set([hit.path]))
    const parts = hit.path.split('/')
    const dirs = new Set()
    let acc = ''
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i]
      dirs.add(acc)
    }
    setExpandedDirs(dirs)
  }

  // inPlaceBlocker returns a translation key (or null when in-place is OK).
  // Drives the disabled state of the in-place radio + its tooltip.
  const inPlaceBlocker = () => {
    if (!snapshotMeta) return 'inPlaceNoMeta'
    if (!snapshotMeta.original_path) return 'inPlaceNoOriginalPath'
    if (systemInfo.os && snapshotMeta.os && systemInfo.os !== snapshotMeta.os) return 'inPlaceOsMismatch'
    return null
  }

  // crossHostMismatch returns true when the backup hostname differs from the
  // current machine. Comparison is case-insensitive and ignores the domain
  // suffix — same rule as backend equalHostnames.
  const crossHostMismatch = () => {
    if (!snapshotMeta || !snapshotMeta.hostname || !hostname) return false
    const norm = s => (s || '').toLowerCase().split('.')[0]
    return norm(snapshotMeta.hostname) !== norm(hostname)
  }

  const handleRestoreSnapshot = async () => {
    if (!RestoreSnapshot) {
      showStatus(t('errRuntimeUnavailable'), 'error')
      return
    }
    if (!selectedSnapshot) {
      showStatus('' + t('selectSnapshotFirst'), 'error')
      return
    }

    // Resolve effective mode. The UI radio is binary (in-place / alternate);
    // the alternate sub-mode comes from the "keep tree" toggle.
    let effectiveMode = restoreMode
    if (restoreMode !== 'original') {
      effectiveMode = restoreKeepTree ? 'alternate_abs' : 'alternate_flat'
    }

    if (effectiveMode !== 'original' && !restoreDestPath) {
      showStatus('' + t('destinationRequired'), 'error')
      return
    }

    // In-place: scary, get explicit confirmation. confirm() is a stopgap until
    // we wire a real modal — for the alpha phase it's enough and the message
    // is precise about what will happen.
    if (effectiveMode === 'original') {
      const target = snapshotMeta?.original_path || '?'
      const msg = t('inPlaceConfirm').replace('{path}', target)
      // eslint-disable-next-line no-alert
      if (!window.confirm(msg)) {
        return
      }
    }

    // Empty selection = restore everything in the snapshot
    const includes = Array.from(selectedPaths)

    setRestoreLoading(true)
    setRestoreProgress(0)
    showStatus(`${t('statusRestoring').replace('{time}', selectedSnapshot.time)}`, 'info')

    try {
      await RestoreSnapshot(
        restorePBSID || '',
        selectedSnapshot.backup_id || restoreBackupId,
        selectedSnapshot.id,
        restoreDestPath,
        effectiveMode,
        includes,
        restoreAllowCrossHost,
        restoreOptions.acls,
        restoreOptions.ads,
        restoreOptions.timestamps,
        restoreOptions.overwrite
      )
      // Completion arrives via the restore:complete event.
    } catch (err) {
      setRestoreLoading(false)
      showStatus(`${t('statusError')} ${err}`, 'error')
    }
  }

  // ===== tree helpers (snapshot navigation) =====

  // Build a map childrenByDir: dir -> [entry...] from the flat list, plus a
  // set of all dir paths. Re-derived on every render — entries are tiny.
  const buildTree = (entries) => {
    const childrenByDir = new Map()
    const dirSet = new Set([''])
    childrenByDir.set('', [])
    for (const e of entries) {
      if (e.is_dir) dirSet.add(e.path)
    }
    for (const e of entries) {
      const slash = e.path.lastIndexOf('/')
      const parent = slash < 0 ? '' : e.path.substring(0, slash)
      // Some archives may emit a child without ever emitting the parent dir
      // entry. Make sure such parents still exist as buckets.
      if (!childrenByDir.has(parent)) childrenByDir.set(parent, [])
      childrenByDir.get(parent).push(e)
      if (e.is_dir && !childrenByDir.has(e.path)) childrenByDir.set(e.path, [])
    }
    // Sort each bucket: dirs first, then alphabetical
    for (const list of childrenByDir.values()) {
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
        return a.path.localeCompare(b.path)
      })
    }
    return childrenByDir
  }

  const toggleDir = (path) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const togglePathSelection = (path) => {
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const formatBytes = (bytes) => {
    if (!bytes || bytes < 1024) return `${bytes || 0} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let n = bytes / 1024
    let i = 0
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
    return `${n.toFixed(1)} ${units[i]}`
  }

  // Reconstruct the absolute on-disk location a file came from, by joining the
  // backup's original_path (from the meta sidecar) with the archive-relative
  // path. Critical for split backups, where each part is a separate backup-id
  // and the relative tree alone doesn't tell you which physical folder/drive a
  // file belonged to. Returns null when the snapshot has no meta sidecar.
  const absOriginPath = (archivePath) => {
    const root = snapshotMeta?.original_path
    if (!root) return null
    const sep = (snapshotMeta?.os === 'windows' || root.includes('\\')) ? '\\' : '/'
    const base = root.endsWith(sep) ? root.slice(0, -1) : root
    if (!archivePath) return base
    return base + sep + archivePath.split('/').join(sep)
  }

  // Total bytes the current selection will restore. Selecting a directory pulls
  // in all its descendants, so we sum every file that is itself selected or
  // lives under a selected path. An empty selection means "restore everything",
  // so we sum the whole snapshot. Memoized — snapshots can hold 100k+ entries.
  const selectionBytes = useMemo(() => {
    if (!snapshotEntries.length) return 0
    if (selectedPaths.size === 0) {
      return snapshotEntries.reduce((sum, e) => e.is_dir ? sum : sum + (e.size || 0), 0)
    }
    const sel = Array.from(selectedPaths)
    let sum = 0
    for (const e of snapshotEntries) {
      if (e.is_dir) continue
      for (const p of sel) {
        if (e.path === p || e.path.startsWith(p + '/')) { sum += (e.size || 0); break }
      }
    }
    return sum
  }, [snapshotEntries, selectedPaths])

  // Recursive renderer driven by the children map. Depth is only used for the
  // visual indent.
  const renderTreeNode = (entry, childrenByDir, depth) => {
    const isExpanded = expandedDirs.has(entry.path)
    const isSelected = selectedPaths.has(entry.path)
    const indent = { paddingLeft: `${depth * 16}px` }
    const origin = absOriginPath(entry.path)
    const rowTitle = origin ? tf('originTooltip', { path: origin }) : entry.path
    return (
      <div key={entry.path}>
        <div title={rowTitle} className="tree-row" style={indent}>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => togglePathSelection(entry.path)}
          />
          {entry.is_dir ? (
            <button
              type="button"
              className="tree-toggle"
              onClick={() => toggleDir(entry.path)}
              aria-expanded={isExpanded}
              aria-label={entry.path}
            >
              {isExpanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
            </button>
          ) : (
            <span style={{ width: '12px', flexShrink: 0 }} />
          )}
          <span className={`tree-icon${entry.is_dir ? ' is-dir' : ''}`}>
            {entry.is_dir
              ? (isExpanded ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />)
              : <FileIcon size={15} />}
          </span>
          <span
            className="tree-name"
            onClick={() => entry.is_dir && toggleDir(entry.path)}
            style={{ cursor: entry.is_dir ? 'pointer' : 'default' }}
          >
            {entry.path.split('/').pop() || entry.path}
          </span>
          {!entry.is_dir && <span className="tree-size">{formatBytes(entry.size)}</span>}
        </div>
        {entry.is_dir && isExpanded && (childrenByDir.get(entry.path) || []).map(child =>
          renderTreeNode(child, childrenByDir, depth + 1)
        )}
      </div>
    )
  }

  // "Is a backup running" comes from the tracker snapshot, never from the percent:
  // the percent is legitimately 0 during the indeterminate window and for the whole
  // run in service mode, which used to re-enable the Start button seconds after the
  // backup began (C-2).
  const backupRunning = !!(activity.run && activity.run.running)

  const NAV = [
    { id: 'servers', label: t('tabServers'), Icon: DatabaseIcon },
    { id: 'backup', label: t('tabBackup'), Icon: CloudArrowUpIcon },
    { id: 'activity', label: t('tabActivity'), Icon: PulseIcon, live: backupRunning },
    { id: 'restore', label: t('tabRestore'), Icon: ArrowCounterClockwiseIcon },
    { id: 'about', label: t('tabAbout'), Icon: InfoIcon },
  ]

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-brand">
          <span className="titlebar-mark"><ShieldCheckIcon size={17} weight="fill" /></span>
          <span className="titlebar-name">{t('appTitle')}</span>
          <span className="titlebar-version">{appVersion}</span>
        </div>
        <div className="titlebar-tools">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <div className="shell">
        <nav className="sidebar">
          {NAV.map(({ id, label, Icon, live }) => (
            <button
              key={id}
              type="button"
              className="nav-item"
              aria-current={activeTab === id ? 'page' : undefined}
              onClick={() => setActiveTab(id)}
              title={label}
            >
              <Icon size={17} />
              <span>{label}</span>
              {live && <span className="live-dot" aria-hidden="true" />}
            </button>
          ))}
        </nav>

        <main className="content">

        {/* PBS Configuration Tab */}
        <div className={`panel ${activeTab === 'servers' ? 'active' : ''}`}>
          <h2>{t('serversTitle')}</h2>
          <p className="panel-lede">{t('multiPBSText')}</p>

          {pbsServers.length === 0 ? (
            <div className="empty">
              <span className="empty-icon"><DatabaseIcon size={30} /></span>
              <h3>{t('welcomeMessage')}</h3>
              <p>{t('welcomeText')}</p>
              {!config.baseurl && (
                <p>
                  <a
                    href={`${t('chooseBackupUrl')}?utm_source=NimbusGui&utm_medium=tooling&utm_campaign=version-${appVersion}&utm_content=first-setup`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('orderStorage')}
                  </a>
                </p>
              )}
            </div>
          ) : (
            <div className="section">
              <h3>{t('configuredServers')} ({pbsServers.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('name')}</th>
                      <th>{t('url')}</th>
                      <th>{t('datastore')}</th>
                      <th>{t('status')}</th>
                      <th style={{ textAlign: 'right' }}>{t('actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pbsServers.map(server => (
                      <tr key={server.id}>
                        <td>
                          <span className="cell-primary">{server.name}</span>
                          {server.id === defaultPBSID && (
                            <span className="badge" style={{ marginLeft: 'var(--s2)' }}>
                              <StarIcon size={11} weight="fill" />{t('default')}
                            </span>
                          )}
                          {server.description && <div className="cell-sub">{server.description}</div>}
                        </td>
                        <td className="mono">{server.baseurl}</td>
                        <td>{server.datastore}{server.namespace ? `/${server.namespace}` : ''}</td>
                        <td>
                          {serverStatus[server.id] === 'testing' && <span className="state state-busy">{t('testing')}</span>}
                          {serverStatus[server.id] === 'online' && <span className="state state-ok">{t('online')}</span>}
                          {serverStatus[server.id] === 'offline' && <span className="state state-bad">{t('offline')}</span>}
                          {!serverStatus[server.id] && <span className="state state-unknown">{t('untested')}</span>}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button className="btn btn-quiet" onClick={() => handleTestPBSConnection(server.id)} title={t('test')}>
                              <MagnifyingGlassIcon size={14} />{t('test')}
                            </button>
                            <button className="btn btn-quiet" onClick={() => handleEditServer(server)} title={t('edit')}>
                              <PencilSimpleIcon size={14} />{t('edit')}
                            </button>
                            {server.id !== defaultPBSID && (
                              <button className="btn btn-quiet" onClick={() => handleSetDefaultPBS(server.id)} title={t('setAsDefault')}>
                                <StarIcon size={14} />{t('setAsDefault')}
                              </button>
                            )}
                            <button className="btn btn-quiet is-danger" onClick={() => handleDeletePBSServer(server.id)} title={t('delete')}>
                              <TrashIcon size={14} />{t('delete')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="form-hint">{t('multiPBSExample')}</p>
            </div>
          )}

          {/* One form for both add and edit; the heading carries the mode. */}
          <div className="section">
            <h3>
              {editingServer
                ? t('editServer')
                : pbsServers.length === 0 ? t('addYourServer') : t('addAnotherServer')}
            </h3>

            <div className="field-row">
              <div className="form-group">
                <label htmlFor="srv-name">{t('serverName')}</label>
                <input
                  id="srv-name"
                  type="text"
                  value={serverFormData.name}
                  onChange={(e) => setServerFormData({...serverFormData, name: e.target.value})}
                  placeholder="SSD Rapide"
                />
              </div>

              {!editingServer && (
                <div className="form-group">
                  <label htmlFor="srv-id">{t('serverID')}</label>
                  <input
                    id="srv-id"
                    type="text"
                    value={serverFormData.id}
                    onChange={(e) => setServerFormData({...serverFormData, id: e.target.value})}
                    placeholder={t('serverIDPlaceholder')}
                  />
                </div>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="srv-url">{t('serverURL')}</label>
              <input
                id="srv-url"
                type="text"
                value={serverFormData.baseurl}
                onChange={(e) => setServerFormData({...serverFormData, baseurl: e.target.value})}
                placeholder="https://pbs-ssd.example.com:8007"
              />
            </div>

            <div className="field-row">
              <div className="form-group">
                <label htmlFor="srv-authid">{t('authID')}</label>
                <input
                  id="srv-authid"
                  type="text"
                  value={serverFormData.authid}
                  onChange={(e) => setServerFormData({...serverFormData, authid: e.target.value})}
                  placeholder="backup@pbs!token-name"
                />
              </div>

              <div className="form-group">
                <label htmlFor="srv-secret">{t('secret')}</label>
                <input
                  id="srv-secret"
                  type="password"
                  value={serverFormData.secret}
                  onChange={(e) => setServerFormData({...serverFormData, secret: e.target.value})}
                  placeholder={serverFormData.secret_set ? t('secretKeepPlaceholder') : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
                />
              </div>
            </div>

            <div className="field-row">
              <div className="form-group">
                <label htmlFor="srv-datastore">{t('datastore')}</label>
                <input
                  id="srv-datastore"
                  type="text"
                  value={serverFormData.datastore}
                  onChange={(e) => setServerFormData({...serverFormData, datastore: e.target.value})}
                  placeholder="ssd-fast"
                />
              </div>

              <div className="form-group">
                <label htmlFor="srv-namespace">{t('namespace')}</label>
                <input
                  id="srv-namespace"
                  type="text"
                  value={serverFormData.namespace}
                  onChange={(e) => setServerFormData({...serverFormData, namespace: e.target.value})}
                  placeholder="clients"
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="srv-fp">{t('certFingerprint')}</label>
              <input
                id="srv-fp"
                type="text"
                className="mono"
                value={serverFormData.certfingerprint}
                onChange={(e) => setServerFormData({...serverFormData, certfingerprint: e.target.value})}
                placeholder="AA:BB:CC:DD:..."
              />
            </div>

            <div className="form-group">
              <label htmlFor="srv-desc">{t('description')}</label>
              <textarea
                id="srv-desc"
                value={serverFormData.description}
                onChange={(e) => setServerFormData({...serverFormData, description: e.target.value})}
                placeholder={t('descriptionPlaceholder')}
                rows="2"
              />
            </div>

            <div className="btn-row">
              {editingServer ? (
                <>
                  <button className="btn btn-primary" onClick={handleUpdatePBSServer}>
                    <FloppyDiskIcon size={15} />{t('update')}
                  </button>
                  <button className="btn" onClick={handleCancelEdit}>
                    <XIcon size={15} />{t('cancel')}
                  </button>
                </>
              ) : (
                <button className="btn btn-primary" onClick={handleAddPBSServer}>
                  <PlusIcon size={15} />{pbsServers.length === 0 ? t('addFirstServer') : t('addServer')}
                </button>
              )}
            </div>

            <div className="note" style={{ marginTop: 'var(--s5)' }}>
              <strong>{t('tipTitle')}</strong> {t('tipAPIToken')}<br/>
              {t('tipAPITokenPath')}
            </div>
          </div>

          {status.visible && activeTab === 'servers' && (
            <div className={`status ${status.type} visible`}>{status.message}</div>
          )}
        </div>

        {/* Backup Tab */}
        <div className={`panel ${activeTab === 'backup' ? 'active' : ''}`}>
          <h2>{t('backupTitle')}</h2>
          <p className="panel-lede">{t('backupLede')}</p>

          <div className="field-row">
            <div className="form-group">
              <label htmlFor="bk-type">{t('backupType')}</label>
              <select id="bk-type" value={backupType} onChange={(e) => setBackupType(e.target.value)}>
                <option value="directory">{t('backupTypeDirectory')}</option>
                {/* <option value="machine">{t('backupTypeMachine')}</option> */}
              </select>
            </div>

            <div className="form-group">
              <label>{t('executionMode')}</label>
              <div className="segmented">
                <button
                  type="button"
                  onClick={() => setBackupMode('oneshot')}
                  aria-pressed={backupMode === 'oneshot'}
                >
                  <PlayIcon size={14} />{t('oneshotMode')}
                </button>
                <button
                  type="button"
                  onClick={() => setBackupMode('scheduled')}
                  aria-pressed={backupMode === 'scheduled'}
                >
                  <ClockIcon size={14} />{t('scheduledMode')}
                </button>
              </div>
            </div>
          </div>

          {/* Scheduling Options */}
          {backupMode === 'scheduled' && (
            <div className="section">
              <h3>{t('schedulingConfig')}</h3>

              {editingJobId && (
                <div className="note note-warn">
                  <strong>{t('editMode')}</strong> {t('editModeText')}
                </div>
              )}

              <div className="form-group" style={{ maxWidth: '200px' }}>
                <label htmlFor="bk-time">{t('dailyExecutionTime')}</label>
                <input
                  id="bk-time"
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                />
              </div>

              <label className="check">
                <input
                  type="checkbox"
                  checked={runAtStartup}
                  onChange={(e) => setRunAtStartup(e.target.checked)}
                />
                <span className="check-label">{t('runAtStartup')}</span>
              </label>

              <div className="note note-accent">
                {t('schedulingInfo')} <strong>{scheduleTime}</strong>
                {runAtStartup && <><br/>{t('andAtStartup')}</>}
              </div>
            </div>
          )}

          <div className="section">
            {backupType === 'directory' ? (
              <div className="form-group">
                <label htmlFor="bk-dirs">{t('directoriesToBackup')}</label>
                <textarea
                  id="bk-dirs"
                  value={backupDirs}
                  onChange={(e) => {
                    setBackupDirs(e.target.value)
                    // Update config.backupdir with first directory for compatibility
                    const dirs = e.target.value.split('\n').map(d => d.trim()).filter(d => d)
                    setConfig({...config, backupdir: dirs[0] || ''})
                  }}
                  rows="4"
                  placeholder="C:\Data&#10;C:\Users&#10;D:\Documents"
                />
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label>{t('physicalDisksToBackup')}</label>
                  {physicalDisks.length === 0 ? (
                    <p className="form-hint">{t('loadingDisks')}</p>
                  ) : (
                    physicalDisks.map(disk => (
                      <label key={disk.path} className="check">
                        <input
                          type="checkbox"
                          checked={selectedDrives.includes(disk.path)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedDrives([...selectedDrives, disk.path])
                            } else {
                              setSelectedDrives(selectedDrives.filter(d => d !== disk.path))
                            }
                          }}
                        />
                        <span className="check-label">{disk.label}</span>
                      </label>
                    ))
                  )}
                </div>

                <div className="form-group">
                  <label htmlFor="bk-exclude">{t('filesToExclude')}</label>
                  <textarea
                    id="bk-exclude"
                    value={excludeList}
                    onChange={(e) => setExcludeList(e.target.value)}
                    rows="4"
                    placeholder="*.tmp&#10;*.log&#10;C:\Windows\Temp"
                  />
                </div>
              </>
            )}

            <div className="form-group">
              <label htmlFor="bk-id">{t('backupID')}</label>
              <input
                id="bk-id"
                type="text"
                value={config['backup-id']}
                onChange={(e) => setConfig({...config, 'backup-id': e.target.value})}
                placeholder={hostname || t('backupIDPlaceholderCustom')}
              />
              <p className="form-hint">{t('backupIDPlaceholder')}</p>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={config.usevss}
                onChange={(e) => setConfig({...config, usevss: e.target.checked})}
              />
              <span className="check-label">{t('useVSS')}</span>
            </label>

            {config.usevss && systemInfo.mode === 'Standalone' && !systemInfo.is_admin && (
              <div className="note note-warn">
                <strong>{t('vssAdminRequired')}</strong><br/>
                {t('vssAdminHint')}
              </div>
            )}
            {config.usevss && systemInfo.service_available && (
              <div className="note note-ok">
                <strong>{t('vssServiceAvailable')}</strong><br/>
                {t('vssServiceHint')}
              </div>
            )}

            {backupType === 'directory' && backupMode === 'oneshot' && (
              <>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={splitFirstBackup}
                    onChange={(e) => setSplitFirstBackup(e.target.checked)}
                  />
                  <span className="check-label">
                    {t('splitFirstBackup')}
                    <small>{t('splitFirstBackupHint')}</small>
                  </span>
                </label>
              </>
            )}
          </div>

          {/* Only a reminder that something is running: the full progress view
              (ETA, throughput, chunk stats, log) now lives on the Activity tab. */}
          {backupRunning && (
            <div className="section">
              <div className="progress-mini">
                <div className="progress"><div className="progress-bar" style={{ width: `${progress}%` }} /></div>
                <span className="progress-pct">{progress}%</span>
                <button type="button" className="btn btn-sm" onClick={() => setActiveTab('activity')}>
                  <PulseIcon size={13} />{t('activityOpenActivity')}
                </button>
              </div>
              {status.message && status.type === 'info' && (
                <p className="form-hint">{status.message}</p>
              )}
            </div>
          )}

          <div className="btn-row">
            <button className="btn btn-primary" onClick={handleStartBackup} disabled={backupRunning}>
              {backupMode === 'oneshot' ? (
                <><CloudArrowUpIcon size={15} />{backupRunning ? t('backupInProgress') : t('startBackup')}</>
              ) : (
                <><FloppyDiskIcon size={15} />{editingJobId ? t('updateSchedule') : t('saveSchedule')}</>
              )}
            </button>

            {backupMode === 'oneshot' && (
              <button className="btn" onClick={() => setProgress(0)} disabled={!backupRunning}>
                <StopIcon size={15} />{t('stopBackup')}
              </button>
            )}

            {backupMode === 'scheduled' && editingJobId && (
              <button className="btn" onClick={() => {
                setEditingJobId(null)
                setScheduleTime('02:00')
                setRunAtStartup(false)
                setBackupDirs('')
                setExcludeList('')
                setBackupType('directory')
                setActiveTab('scheduled')
                showStatus(t('statusEditCancelled'), 'info')
              }}>
                <XIcon size={15} />{t('cancel')}
              </button>
            )}
          </div>

          {/* Scheduled Jobs List */}
          {backupMode === 'scheduled' && scheduledJobs.length > 0 && (
            <div className="section">
              <h3>{t('scheduledJobs')}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('name')}</th>
                      <th>{t('dailyExecutionTime')}</th>
                      <th>{t('directoriesToBackup')}</th>
                      <th style={{ textAlign: 'right' }}>{t('actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheduledJobs.map(job => (
                      <tr key={job.id}>
                        <td className="cell-primary">{job.name}</td>
                        <td>
                          {job.scheduleTime}
                          {job.runAtStartup && <div className="cell-sub">{t('atStartup')}</div>}
                        </td>
                        <td className="mono">{job.backupDirs.join(', ')}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="btn btn-quiet"
                              onClick={() => {
                                // Load job data into form for editing
                                setEditingJobId(job.id)
                                setBackupMode('scheduled')
                                setScheduleTime(job.scheduleTime)
                                setRunAtStartup(job.runAtStartup)
                                setBackupDirs(job.backupDirs.join('\n'))
                                setConfig({...config, 'backup-id': job.backupId, usevss: job.useVSS})
                                setBackupType(job.backupType)
                                setExcludeList(job.excludeList.join('\n'))
                                // Switch to backup tab to show the form
                                setActiveTab('backup')
                                showStatus(t('editModeInfo'), 'info')
                              }}
                            >
                              <PencilSimpleIcon size={14} />{t('editJob')}
                            </button>
                            <button
                              className="btn btn-quiet is-danger"
                              onClick={async () => {
                                try {
                                  await DeleteScheduledJob(job.id)
                                  setScheduledJobs(scheduledJobs.filter(j => j.id !== job.id))
                                  showStatus(t('statusJobDeleted'), 'success')
                                  // Cancel edit mode if deleting the job being edited
                                  if (editingJobId === job.id) {
                                    setEditingJobId(null)
                                  }
                                } catch (err) {
                                  showStatus(`${t('statusError')} ${err}`, 'error')
                                }
                              }}
                            >
                              <TrashIcon size={14} />{t('deleteJob')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Job History */}
          {jobHistory.length > 0 && (
            <div className="section">
              <h3>{t('backupHistory')}</h3>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {jobHistory.slice(0, 6).map(job => (
                      <tr key={job.id}>
                        <td style={{ width: '1%' }}>
                          {job.status === 'success' && <span className="state state-ok" />}
                          {job.status === 'failed' && <span className="state state-bad" />}
                          {job.status !== 'success' && job.status !== 'failed' && <span className="state state-unknown" />}
                        </td>
                        <td>
                          <span className="cell-primary">{job.name}</span>
                          {job.message && <div className="cell-sub">{job.message}</div>}
                        </td>
                        <td className="cell-sub">{new Date(job.timestamp).toLocaleString(t('locale'))}</td>
                        <td>
                          <div className="row-actions">
                            {job.status === 'failed' && (
                              <button
                                className="btn btn-quiet"
                                onClick={() => {
                                  // Re-run failed job
                                  setBackupDirs(job.backupDirs.join('\n'))
                                  setConfig({...config, 'backup-id': job.backupId, usevss: job.useVSS})
                                  showStatus(t('configLoaded'), 'success')
                                }}
                              >
                                <ArrowClockwiseIcon size={14} />{t('rerun')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {status.visible && activeTab === 'backup' && (
            <div className={`status ${status.type} visible`}>{status.message}</div>
          )}
        </div>

        {/* Activity Tab */}
        <div className={`panel ${activeTab === 'activity' ? 'active' : ''}`}>
          <h2>{t('activityTitle')}</h2>
          <p className="panel-lede">{t('activityLede')}</p>
          <ActivityPanel activity={activity} onGoToBackup={() => setActiveTab('backup')} />

          {status.visible && activeTab === 'activity' && (
            <div className={`status ${status.type} visible`}>{status.message}</div>
          )}
        </div>

        {/* Restore Tab */}
        <div className={`panel ${activeTab === 'restore' ? 'active' : ''}`}>
          <h2>{t('restoreTitle')}</h2>
          <p className="panel-lede">{t('restoreInfoText')} {t('restoreInfoText2')}</p>

          <div className="note note-warn">
            <strong>{t('restoreBetaTitle')}</strong><br/>{t('restoreBetaIntro')}
            <ul className="plain-list" style={{ marginTop: 'var(--s2)' }}>
              <li>{t('restoreBetaFilesDirs')}</li>
              <li>{t('restoreBetaSelective')}</li>
              <li>{t('restoreBetaTimestamps')}</li>
              <li>{t('restoreBetaACLs')} <span className="faint">({t('comingSoon')})</span></li>
            </ul>
          </div>

          {/* PBS server selector + Backup ID */}
          <div className="field-row">
            <div className="form-group">
              <label htmlFor="rs-server">{t('restorePBSServer')}</label>
              <select
                id="rs-server"
                value={restorePBSID}
                onChange={(e) => {
                  setRestorePBSID(e.target.value)
                  setShowSnapshots(false)
                  setSelectedSnapshot(null)
                  setSnapshotEntries([])
                }}
              >
                {pbsServers.length === 0 && <option value="">{t('noPBSServer')}</option>}
                {pbsServers.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.id === defaultPBSID ? ` (${t('default')})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="rs-id">{t('backupIDToRestore')}</label>
              <input
                id="rs-id"
                type="text"
                value={restoreBackupId || hostname}
                onChange={(e) => setRestoreBackupId(e.target.value)}
                placeholder={hostname || t('backupIDPlaceholderCustom')}
              />
            </div>
          </div>

          <div className="btn-row">
            <button className="btn btn-primary" onClick={handleListSnapshots}>
              <ClockIcon size={15} />{t('listSnapshots')}
            </button>
            <button className="btn" type="button" onClick={() => setShowSearch(v => !v)} aria-expanded={showSearch}>
              <MagnifyingGlassIcon size={15} />{t('searchTitle')}
            </button>
          </div>

          {showSearch && (
            <div className="section">
              <h3>{t('searchTitle')}</h3>
              <p className="form-hint" style={{ marginBottom: 'var(--s3)' }}>
                {tf('searchHint', { prefix: restoreBackupId || hostname || '?' })}
              </p>

              <div className="field-row">
                <div className="form-group">
                  <label htmlFor="rs-q">{t('searchQueryLabel')}</label>
                  <input
                    id="rs-q"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('searchQueryPlaceholder')}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !searchRunning) handleSearch() }}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="rs-mode">{t('searchModeLabel')}</label>
                  <select id="rs-mode" value={searchMode} onChange={(e) => setSearchMode(e.target.value)}>
                    <option value="name">{t('searchModeName')}</option>
                    <option value="regex">{t('searchModeRegex')}</option>
                    <option value="path">{t('searchModePath')}</option>
                  </select>
                </div>
              </div>

              <div className="field-row">
                <div className="form-group">
                  <label htmlFor="rs-from">{t('searchFrom')}</label>
                  <input id="rs-from" type="date" value={searchFrom} onChange={(e) => setSearchFrom(e.target.value)} />
                </div>
                <div className="form-group">
                  <label htmlFor="rs-to">{t('searchTo')}</label>
                  <input id="rs-to" type="date" value={searchTo} onChange={(e) => setSearchTo(e.target.value)} />
                </div>
              </div>

              <label className="check">
                <input
                  type="checkbox"
                  checked={searchAssembleMissing}
                  onChange={(e) => setSearchAssembleMissing(e.target.checked)}
                />
                <span className="check-label">{t('searchAssembleMissing')}</span>
              </label>

              <div className="btn-row">
                <button className="btn btn-primary" type="button" onClick={handleSearch} disabled={searchRunning}>
                  <MagnifyingGlassIcon size={15} />{searchRunning ? t('searching') : t('searchButton')}
                </button>
                {searchRunning && (
                  <>
                    <button className="btn" type="button" onClick={handleCancelSearch}>
                      <XIcon size={15} />{t('cancel')}
                    </button>
                    <span className="muted">{searchProgress.percent}% {searchProgress.message}</span>
                  </>
                )}
              </div>

              {searchResult && (
                <div style={{ marginTop: 'var(--s4)' }}>
                  <p className="form-hint">
                    {tf('searchSummary', {
                      hits: searchResult.hits ? searchResult.hits.length : 0,
                      searched: searchResult.snapshots_searched || 0,
                      assembled: searchResult.snapshots_assembled || 0,
                    })}
                  </p>
                  {searchResult.truncated && (
                    <div className="note note-warn">{tf('searchTruncated', { max: 5000 })}</div>
                  )}
                  {searchResult.cancelled && (
                    <div className="note note-warn">{t('searchCancelled')}</div>
                  )}
                  {searchResult.snapshots_in_range === 0 && (
                    <div className="note note-warn">{t('searchNoSnapshotsInRange')}</div>
                  )}
                  {(searchResult.snapshots_skipped > 0 && !searchAssembleMissing) && (
                    <div className="note note-warn">
                      {tf('searchSkippedWarning', { n: searchResult.snapshots_skipped })}
                    </div>
                  )}

                  <div className="tree" style={{ maxHeight: '320px' }}>
                    {(!searchResult.hits || searchResult.hits.length === 0) ? (
                      <p className="form-hint" style={{ padding: 'var(--s3)' }}>{t('searchNoResults')}</p>
                    ) : (
                      searchResult.hits.map((hit, idx) => (
                        <div
                          key={`${hit.backup_id}-${hit.snapshot_time}-${hit.path}-${idx}`}
                          title={hit.origin_path || hit.path}
                          className="tree-row"
                        >
                          <span className={`tree-icon${hit.is_dir ? ' is-dir' : ''}`}>
                            {hit.is_dir ? <FolderIcon size={15} /> : <FileIcon size={15} />}
                          </span>
                          <div className="tree-name">
                            <div className="cell-primary" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {hit.path.split('/').pop() || hit.path}
                            </div>
                            <div className="cell-sub mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {hit.origin_path || hit.path}
                            </div>
                            <div className="cell-sub">
                              {hit.backup_id} · {new Date(hit.snapshot_time * 1000).toLocaleString(t('locale'))}
                              {hit.is_dir ? '' : ` · ${formatBytes(hit.size)}`}
                            </div>
                          </div>
                          <button className="btn btn-quiet" type="button" onClick={() => handleRestoreHit(hit)}>
                            {t('searchRestoreThis')}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {showSnapshots && (
            <div className="section">
              <h3>{t('availableSnapshots')}</h3>
              {snapshots.length === 0 ? (
                <p className="muted">{t('noSnapshotFound')}</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('metaBackupTime')}</th>
                        <th>{t('backupID')}</th>
                        <th>{t('typeLabel')}</th>
                        <th style={{ textAlign: 'right' }}>{t('actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshots.map((snap, idx) => {
                        const isActive = selectedSnapshot && selectedSnapshot.id === snap.id && selectedSnapshot.backup_id === snap.backup_id
                        return (
                          <tr key={idx}>
                            <td className="cell-primary">{snap.time}</td>
                            <td className="mono">{snap.backup_id}</td>
                            <td>{snap.backup_type || '-'}</td>
                            <td>
                              <div className="row-actions">
                                <button
                                  className={isActive ? 'btn btn-primary btn-sm' : 'btn btn-quiet'}
                                  onClick={() => handleSelectSnapshot(snap)}
                                >
                                  {isActive && <CheckCircleIcon size={14} weight="fill" />}
                                  {isActive ? t('snapshotSelected') : t('selectSnapshot')}
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Backup origin banner - driven by the .nimbus_backup_meta.json sidecar */}
          {selectedSnapshot && snapshotMeta && (
            <div className="note note-accent">
              <dl className="kv">
                <dt>{t('metaOriginalPath')}</dt>
                <dd className="mono">{snapshotMeta.original_path || '-'}</dd>
                <dt>{t('metaHostname')}</dt>
                <dd>{snapshotMeta.hostname || '-'}{snapshotMeta.os ? ` (${snapshotMeta.os})` : ''}{snapshotMeta.vss_used ? ' · VSS' : ''}</dd>
                <dt>{t('metaBackupTime')}</dt>
                <dd>{snapshotMeta.backup_time || '-'}{snapshotMeta.client_version ? ` · ${snapshotMeta.client_version}` : ''}</dd>
              </dl>
            </div>
          )}

          {/* Snapshot navigation tree */}
          {selectedSnapshot && (
            <div className="section">
              <h3>{t('snapshotContents')}</h3>
              <div className="btn-row" style={{ marginTop: 0, marginBottom: 'var(--s2)' }}>
                <span className="muted">{selectedSnapshot.time}</span>
                <button
                  className="btn btn-quiet"
                  type="button"
                  onClick={handleReloadSnapshot}
                  title={t('reloadTreeHint')}
                >
                  <ArrowClockwiseIcon size={14} />{t('reloadTree')}
                </button>
              </div>
              <p className="form-hint" style={{ marginBottom: 'var(--s2)' }}>{t('treeHint')}</p>

              <div className="tree">
                {snapshotEntries.length === 0 ? (
                  <p className="form-hint" style={{ padding: 'var(--s3)' }}>{t('loadingOrEmpty')}</p>
                ) : (
                  (() => {
                    const tree = buildTree(snapshotEntries)
                    const roots = tree.get('') || []
                    return roots.map(e => renderTreeNode(e, tree, 0))
                  })()
                )}
              </div>

              <p className="form-hint">
                {selectedPaths.size === 0
                  ? tf('selectionEmptyAllSize', { size: formatBytes(selectionBytes) })
                  : tf('selectionCountSize', { n: selectedPaths.size, size: formatBytes(selectionBytes) })}
              </p>
            </div>
          )}

          {/* Restore mode picker + destination + options + restore button */}
          {selectedSnapshot && (() => {
            const blocker = inPlaceBlocker()
            const isInPlace = restoreMode === 'original'
            const crossHost = isInPlace && crossHostMismatch()
            const blockerTooltip = blocker ? (t(blocker) || '') : ''
            return (
              <div className="section">
                <label className="check" title={blockerTooltip} style={{ opacity: blocker ? 0.5 : 1 }}>
                  <input
                    type="radio"
                    name="restoreMode"
                    value="original"
                    checked={restoreMode === 'original'}
                    disabled={!!blocker}
                    onChange={() => setRestoreMode('original')}
                  />
                  <span className="check-label">
                    {t('restoreModeInPlace')}
                    {blocker && <small>{blockerTooltip}</small>}
                  </span>
                </label>
                <label className="check">
                  <input
                    type="radio"
                    name="restoreMode"
                    value="alternate"
                    checked={restoreMode !== 'original'}
                    onChange={() => setRestoreMode('alternate_abs')}
                  />
                  <span className="check-label">{t('restoreModeAlternate')}</span>
                </label>

                {/* In-place: warning banner + cross-host override */}
                {isInPlace && (
                  <div className="note note-danger">
                    {tf('inPlaceWarning', { path: snapshotMeta?.original_path || '?' })}
                    {crossHost && (
                      <label className="check" style={{ marginTop: 'var(--s2)', marginBottom: 0 }}>
                        <input
                          type="checkbox"
                          checked={restoreAllowCrossHost}
                          onChange={(e) => setRestoreAllowCrossHost(e.target.checked)}
                        />
                        <span className="check-label">
                          {tf('crossHostOverride', { src: snapshotMeta?.hostname || '?', dst: hostname || '?' })}
                        </span>
                      </label>
                    )}
                  </div>
                )}

                {/* Alternate: destination + keep-tree toggle */}
                {!isInPlace && (
                  <>
                    <div className="form-group">
                      <label htmlFor="rs-dest">{t('destinationPath')}</label>
                      <div style={{ display: 'flex', gap: 'var(--s2)' }}>
                        <input
                          id="rs-dest"
                          type="text"
                          value={restoreDestPath}
                          onChange={(e) => setRestoreDestPath(e.target.value)}
                          placeholder="C:\Restore"
                        />
                        <button className="btn" onClick={handleBrowseRestoreDest} type="button">
                          <FolderOpenIcon size={15} />{t('browse')}
                        </button>
                      </div>
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={restoreKeepTree}
                        onChange={(e) => setRestoreKeepTree(e.target.checked)}
                      />
                      <span className="check-label">
                        {t('keepTreeLabel')}
                        <small>{restoreKeepTree ? t('keepTreeOnHint') : t('keepTreeOffHint')}</small>
                      </span>
                    </label>
                  </>
                )}

                <label className="check" style={{ opacity: isInPlace ? 0.5 : 1 }}
                       title={isInPlace ? t('overwriteForcedInPlace') : ''}>
                  <input
                    type="checkbox"
                    checked={isInPlace ? true : restoreOptions.overwrite}
                    disabled={isInPlace}
                    onChange={(e) => setRestoreOptions(o => ({...o, overwrite: e.target.checked}))}
                  />
                  <span className="check-label">{t('optionOverwrite')}</span>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={restoreOptions.timestamps}
                    onChange={(e) => setRestoreOptions(o => ({...o, timestamps: e.target.checked}))}
                  />
                  <span className="check-label">{t('optionTimestamps')}</span>
                </label>
                <label className="check" style={{ opacity: 0.5 }} title={t('optionComingSoon')}>
                  <input type="checkbox" disabled checked={false} />
                  <span className="check-label">{t('optionACLs')} <small>{t('comingSoon')}</small></span>
                </label>
                <label className="check" style={{ opacity: 0.5 }} title={t('optionComingSoon')}>
                  <input type="checkbox" disabled checked={false} />
                  <span className="check-label">{t('optionADS')} <small>{t('comingSoon')}</small></span>
                </label>

                <div className="btn-row">
                  <button
                    className="btn btn-primary"
                    onClick={handleRestoreSnapshot}
                    disabled={restoreLoading || (isInPlace && crossHost && !restoreAllowCrossHost)}
                  >
                    <DownloadSimpleIcon size={15} />{restoreLoading ? t('restoring') : t('restore')}
                  </button>
                </div>

                {restoreLoading && (
                  <>
                    <div className="progress">
                      <div className="progress-bar" style={{ width: `${restoreProgress}%` }} />
                    </div>
                    <p className="form-hint">{restoreProgress}%</p>
                  </>
                )}
              </div>
            )
          })()}

          {status.visible && activeTab === 'restore' && (
            <div className={`status ${status.type} visible`}>{status.message}</div>
          )}
        </div>

        {/* About Tab */}
        <div className={`panel ${activeTab === 'about' ? 'active' : ''}`}>
          <h2>{t('aboutTitle')}</h2>

          <div className="about-head">
            <img src={logoUrl} alt="" className="about-logo" />
            <div>
              <h3 style={{ marginBottom: 0 }}>Nimbus Backup</h3>
              <p className="muted">{t('version')} {appVersion}</p>
              <p style={{ marginTop: 'var(--s3)' }}>
                <a
                  className="btn btn-primary"
                  href={`${t('chooseBackupUrl')}?utm_source=NimbusGui&utm_medium=tooling&utm_campaign=version-${appVersion}&utm_content=version-${appVersion}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <CloudArrowUpIcon size={15} />{t('orderStorageCTA')}
                </a>
              </p>
            </div>
          </div>

          <div className="section">
            <div className="grid">
              <div>
                <h4>{t('features')}</h4>
                <ul className="plain-list">
                  <li>{t('featuresList.directories')}</li>
                  <li>{t('featuresList.machine')}</li>
                  <li>{t('featuresList.restore')}</li>
                  <li>{t('featuresList.vss')}</li>
                  <li>{t('featuresList.dedup')}</li>
                  <li>{t('featuresList.modern')}</li>
                </ul>
              </div>

              <div>
                <h4>{t('technology')}</h4>
                <ul className="plain-list">
                  <li>{t('techList.wails')}</li>
                  <li>{t('techList.performance')}</li>
                  <li>{t('techList.interface')}</li>
                  <li>{t('techList.logs')}</li>
                  <li>{t('techList.nogpu')}</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="section">
            <p><strong>{t('copyright')}</strong></p>
            <p><a href="https://nimbus.rdem-systems.com">nimbus.rdem-systems.com</a></p>
            <p className="faint" style={{ marginTop: 'var(--s3)', fontSize: 'var(--t-xs)' }}>
              {t('basedOn')}<br/>
              {t('techStack')}
            </p>
          </div>
        </div>
        </main>
      </div>
    </div>
  )
}

export default App
