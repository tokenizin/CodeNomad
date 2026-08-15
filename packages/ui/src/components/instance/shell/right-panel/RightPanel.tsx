import {
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  type Accessor,
  type Component,
} from "solid-js"
import type { ToolState } from "@opencode-ai/sdk/v2"
import type { FileContent, FileNode } from "@opencode-ai/sdk/v2/client"
import IconButton from "@suid/material/IconButton"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"
import PushPinIcon from "@suid/icons-material/PushPin"
import PushPinOutlinedIcon from "@suid/icons-material/PushPinOutlined"

import type { Instance } from "../../../../types/instance"
import type { BackgroundProcess, FileSystemEntry } from "../../../../../../server/src/api-types"
import type { Session } from "../../../../types/session"
import type { PromptInputApi } from "../../../prompt-input/types"
import type { DrawerViewState } from "../types"
import type { DiffContextMode, DiffViewMode, DiffWordWrapMode, RightPanelTab } from "./types"
import { approximateBinarySizeFromBase64, detectImageMime, isImagePath } from "./fileTypes"

import {
  getDefaultWorktreeSlug,
  getGitRepoStatus,
  getWorktreeSlugForSession,
  getWorktrees,
} from "../../../../stores/worktrees"
import { getRootClient } from "../../../../stores/opencode-client"
import { getOpenCodeWorkspaceIdForWorktree } from "../../../../stores/opencode-workspaces"
import { getCachedFileList, setCachedFileList } from "../../../../lib/instance-preload"
import { requestData } from "../../../../lib/opencode-api"
import { serverApi } from "../../../../lib/api-client"
import { showConfirmDialog } from "../../../../stores/alerts"
import { showToastNotification } from "../../../../lib/notifications"
import { getUnreadCount } from "../../../../stores/notifications"
import { useGlobalPointerDrag } from "../useGlobalPointerDrag"
import { useGitChanges } from "./useGitChanges"
import {
  RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY,
  RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY,
  RIGHT_PANEL_FILES_WORD_WRAP_KEY,
  RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_PHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_PHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY,
  RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_NONPHONE_KEY,
  RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_PHONE_KEY,
  RIGHT_PANEL_TAB_STORAGE_KEY,
  readStoredBool,
  readStoredEnum,
  readStoredPanelWidth,
  readStoredRightPanelTab,
} from "../storage"

const LazyGitChangesTab = lazy(() => import("./tabs/GitChangesTab"))
const LazyFilesTab = lazy(() => import("./tabs/FilesTab"))
const LazyStatusTab = lazy(() => import("./tabs/StatusTab"))
const LazyWikiLintTab = lazy(() => import("./tabs/WikiLintTab"))
const LazyNotifyHistoryTab = lazy(() => import("./tabs/NotifyHistoryTab"))

type BrowserFileNode = FileNode & { modifiedAt?: string }

function mergeFileModifiedAt(nodes: FileNode[], entries: FileSystemEntry[]): BrowserFileNode[] {
  const byName = new Map(entries.map((entry) => [entry.name, entry.modifiedAt]))
  const byPath = new Map(
    entries.map((entry) => [String(entry.path || "").replace(/\\/g, "/"), entry.modifiedAt]),
  )
  return nodes.map((node) => {
    const pathKey = String(node.path || "").replace(/\\/g, "/")
    return {
      ...node,
      modifiedAt: byPath.get(pathKey) ?? byName.get(String(node.name || "")) ?? undefined,
    }
  })
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || "")
      const comma = result.indexOf(",")
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"))
    reader.readAsDataURL(file)
  })
}

function RightPanelTabFallback() {
  return <div class="flex-1 min-h-0" />
}

interface RightPanelProps {
  t: (key: string, vars?: Record<string, any>) => string

  instanceId: string
  instance: Instance

  activeSessionId: Accessor<string | null>
  activeSession: Accessor<Session | null>

  latestTodoState: Accessor<ToolState | null>
  backgroundProcessList: Accessor<BackgroundProcess[]>
  onOpenBackgroundOutput: (process: BackgroundProcess) => void
  onStopBackgroundProcess: (processId: string) => Promise<void> | void
  onTerminateBackgroundProcess: (processId: string) => Promise<void> | void

  isPhoneLayout: Accessor<boolean>
  rightDrawerWidth: Accessor<number>
  rightDrawerWidthInitialized: Accessor<boolean>
  rightDrawerState: Accessor<DrawerViewState>
  rightPinned: Accessor<boolean>
  onCloseRightDrawer: () => void
  onPinRightDrawer: () => void
  onUnpinRightDrawer: () => void
  promptInputApi: Accessor<PromptInputApi | null>

  setContentEl: (el: HTMLElement | null) => void
}

const RightPanel: Component<RightPanelProps> = (props) => {
  const [rightPanelTab, setRightPanelTab] = createSignal<RightPanelTab>(readStoredRightPanelTab("git-changes"))
  const defaultStatusSectionIds = ["yolo-mode", "plan", "background-processes", "mcp", "lsp", "plugins"]
  const [rightPanelExpandedItems, setRightPanelExpandedItems] = createSignal<string[]>(defaultStatusSectionIds)

  const [browserPath, setBrowserPath] = createSignal(".")
  const [browserEntries, setBrowserEntries] = createSignal<BrowserFileNode[] | null>(null)
  const [browserLoading, setBrowserLoading] = createSignal(false)
  const [browserUploading, setBrowserUploading] = createSignal(false)
  const [browserError, setBrowserError] = createSignal<string | null>(null)
  const [browserSelectedPath, setBrowserSelectedPath] = createSignal<string | null>(null)
  const [browserSelectedContent, setBrowserSelectedContent] = createSignal<string | null>(null)
  const [browserSelectedLoading, setBrowserSelectedLoading] = createSignal(false)
  const [browserSelectedError, setBrowserSelectedError] = createSignal<string | null>(null)
  const [browserSelectedDirty, setBrowserSelectedDirty] = createSignal(false)
  const [browserSelectedSaving, setBrowserSelectedSaving] = createSignal(false)
  const [browserSelectedOriginalContent, setBrowserSelectedOriginalContent] = createSignal<string | null>(null)
  const [browserSelectedBase64, setBrowserSelectedBase64] = createSignal<{
    base64: string
    mimeType: string
    sizeBytes: number
    path: string
  } | null>(null)

  const [diffViewMode, setDiffViewMode] = createSignal<DiffViewMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, ["split", "unified"] as const) ?? "unified",
  )
  const [diffContextMode, setDiffContextMode] = createSignal<DiffContextMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, ["expanded", "collapsed"] as const) ?? "collapsed",
  )
  const [diffWordWrapMode, setDiffWordWrapMode] = createSignal<DiffWordWrapMode>(
    readStoredEnum(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, ["on", "off"] as const) ?? "on",
  )
  const [filesWordWrapMode, setFilesWordWrapMode] = createSignal<DiffWordWrapMode>(
    readStoredEnum(RIGHT_PANEL_FILES_WORD_WRAP_KEY, ["on", "off"] as const) ?? "off",
  )

  const [filesSplitWidth, setFilesSplitWidth] = createSignal(320)
  const [gitChangesSplitWidth, setGitChangesSplitWidth] = createSignal(320)
  const [activeSplitResize, setActiveSplitResize] = createSignal<"git-changes" | "files" | null>(null)
  const [splitResizeStartX, setSplitResizeStartX] = createSignal(0)
  const [splitResizeStartWidth, setSplitResizeStartWidth] = createSignal(0)

  const [filesListOpen, setFilesListOpen] = createSignal(true)
  const [filesListTouched, setFilesListTouched] = createSignal(false)
  const [gitChangesListOpen, setGitChangesListOpen] = createSignal(true)
  const [gitChangesListTouched, setGitChangesListTouched] = createSignal(false)
  const [gitStagedOpen, setGitStagedOpen] = createSignal(true)
  const [gitUnstagedOpen, setGitUnstagedOpen] = createSignal(true)

  const listLayoutKey = createMemo(() => (props.isPhoneLayout() ? "phone" : "nonphone"))

  const listOpenStorageKey = (tab: "git-changes" | "files") => {
    const layout = listLayoutKey()
    if (tab === "git-changes") {
      return layout === "phone"
        ? RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_PHONE_KEY
        : RIGHT_PANEL_GIT_CHANGES_LIST_OPEN_NONPHONE_KEY
    }
    return layout === "phone" ? RIGHT_PANEL_FILES_LIST_OPEN_PHONE_KEY : RIGHT_PANEL_FILES_LIST_OPEN_NONPHONE_KEY
  }

  const gitSectionStorageKey = (section: "staged" | "unstaged") => {
    const layout = listLayoutKey()
    if (section === "staged") {
      return layout === "phone"
        ? RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_PHONE_KEY
        : RIGHT_PANEL_GIT_CHANGES_STAGED_OPEN_NONPHONE_KEY
    }
    return layout === "phone"
      ? RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_PHONE_KEY
      : RIGHT_PANEL_GIT_CHANGES_UNSTAGED_OPEN_NONPHONE_KEY
  }

  const persistListOpen = (tab: "git-changes" | "files", value: boolean) => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(listOpenStorageKey(tab), value ? "true" : "false")
  }

  const persistGitSectionOpen = (section: "staged" | "unstaged", value: boolean) => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(gitSectionStorageKey(section), value ? "true" : "false")
  }

  createEffect(() => {
    // Refresh persisted visibility when layout changes (phone vs non-phone).
    const layout = listLayoutKey()
    layout

    const filesPersisted = readStoredBool(listOpenStorageKey("files"))
    if (filesPersisted !== null) {
      setFilesListOpen(filesPersisted)
      setFilesListTouched(true)
    } else {
      setFilesListOpen(true)
      setFilesListTouched(false)
    }

    const gitPersisted = readStoredBool(listOpenStorageKey("git-changes"))
    if (gitPersisted !== null) {
      setGitChangesListOpen(gitPersisted)
      setGitChangesListTouched(true)
    } else {
      setGitChangesListOpen(true)
      setGitChangesListTouched(false)
    }

    const stagedPersisted = readStoredBool(gitSectionStorageKey("staged"))
    setGitStagedOpen(stagedPersisted ?? true)

    const unstagedPersisted = readStoredBool(gitSectionStorageKey("unstaged"))
    setGitUnstagedOpen(unstagedPersisted ?? true)
  })

  createEffect(() => {
    // Default behavior: when nothing is selected, keep the file list open.
    // Once the user explicitly toggles it, we stop auto-opening.
    if (rightPanelTab() !== "files") return
    if (filesListTouched()) return
    if (!browserSelectedPath()) {
      setFilesListOpen(true)
    }
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_TAB_STORAGE_KEY, rightPanelTab())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_CHANGES_DIFF_VIEW_MODE_KEY, diffViewMode())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_CHANGES_DIFF_CONTEXT_MODE_KEY, diffContextMode())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_CHANGES_DIFF_WORD_WRAP_KEY, diffWordWrapMode())
  })

  createEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(RIGHT_PANEL_FILES_WORD_WRAP_KEY, filesWordWrapMode())
  })

  const clampSplitWidth = (value: number) => {
    const min = 200
    const maxByDrawer = Math.max(min, Math.floor(props.rightDrawerWidth() * 0.65))
    const max = Math.min(560, maxByDrawer)
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  const [splitWidthsInitialized, setSplitWidthsInitialized] = createSignal(false)

  createEffect(() => {
    if (splitWidthsInitialized()) return
    if (!props.rightDrawerWidthInitialized()) return
    setSplitWidthsInitialized(true)
    setFilesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY, 320)))
    setGitChangesSplitWidth(clampSplitWidth(readStoredPanelWidth(RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY, 320)))
  })

  const persistSplitWidth = (mode: "git-changes" | "files", width: number) => {
    if (typeof window === "undefined") return
    const key = mode === "git-changes" ? RIGHT_PANEL_GIT_CHANGES_SPLIT_WIDTH_KEY : RIGHT_PANEL_FILES_SPLIT_WIDTH_KEY
    window.localStorage.setItem(key, String(width))
  }

  function stopSplitResize() {
    setActiveSplitResize(null)
    if (typeof document === "undefined") return
    splitPointerDrag.stop()
  }

  function splitMouseMove(event: MouseEvent) {
    const mode = activeSplitResize()
    if (!mode) return
    event.preventDefault()
    const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    const delta = (event.clientX - splitResizeStartX()) * (isRtl ? -1 : 1)
    const next = clampSplitWidth(splitResizeStartWidth() + delta)
    if (mode === "git-changes") setGitChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitMouseUp() {
    const mode = activeSplitResize()
    if (mode) {
      const width = mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth()
      persistSplitWidth(mode, width)
    }
    stopSplitResize()
  }

  function splitTouchMove(event: TouchEvent) {
    const mode = activeSplitResize()
    if (!mode) return
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl"
    const delta = (touch.clientX - splitResizeStartX()) * (isRtl ? -1 : 1)
    const next = clampSplitWidth(splitResizeStartWidth() + delta)
    if (mode === "git-changes") setGitChangesSplitWidth(next)
    else setFilesSplitWidth(next)
  }

  function splitTouchEnd() {
    const mode = activeSplitResize()
    if (mode) {
      const width = mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth()
      persistSplitWidth(mode, width)
    }
    stopSplitResize()
  }

  const splitPointerDrag = useGlobalPointerDrag({
    onMouseMove: splitMouseMove,
    onMouseUp: splitMouseUp,
    onTouchMove: splitTouchMove,
    onTouchEnd: splitTouchEnd,
  })

  const startSplitResize = (mode: "git-changes" | "files", clientX: number) => {
    if (typeof document === "undefined") return
    setActiveSplitResize(mode)
    setSplitResizeStartX(clientX)
    setSplitResizeStartWidth(mode === "git-changes" ? gitChangesSplitWidth() : filesSplitWidth())
    splitPointerDrag.start()
  }

  const handleSplitResizeMouseDown = (mode: "git-changes" | "files") => (event: MouseEvent) => {
    event.preventDefault()
    startSplitResize(mode, event.clientX)
  }

  const handleSplitResizeTouchStart = (mode: "git-changes" | "files") => (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!touch) return
    event.preventDefault()
    startSplitResize(mode, touch.clientX)
  }

  onCleanup(() => {
    stopSplitResize()
  })

  const worktreeSlugForViewer = createMemo(() => {
    const sessionId = props.activeSessionId()
    if (sessionId && sessionId !== "info") {
      return getWorktreeSlugForSession(props.instanceId, sessionId)
    }
    return getDefaultWorktreeSlug(props.instanceId)
  })

  const gitChangesWorktreeSlug = createMemo(() => {
    if (getGitRepoStatus(props.instanceId) === false) return null
    const slug = worktreeSlugForViewer().trim()
    return slug ? slug : null
  })

  const gitChangesWorktree = createMemo(() => {
    const slug = gitChangesWorktreeSlug()
    if (!slug) return null
    return getWorktrees(props.instanceId).find((worktree) => worktree.slug === slug) ?? null
  })

  const gitChangesBranchLabel = createMemo(() => {
    const branch = gitChangesWorktree()?.branch?.trim()
    return branch || null
  })

  const browserClient = createMemo(() => getRootClient(props.instanceId))
  const fileWorkspacePayload = async () => {
    const slug = worktreeSlugForViewer().trim()
    if (!slug || slug === "root") return {}
    const workspace = await getOpenCodeWorkspaceIdForWorktree(props.instanceId, slug)
    return workspace ? { workspace } : {}
  }

  const {
    gitStatusEntries,
    gitStatusLoading,
    gitStatusError,
    gitSelectedItemId,
    gitBulkSelectedItemIds,
    gitSelectedLoading,
    gitSelectedError,
    gitSelectedBefore,
    gitSelectedAfter,
    gitSelectedAfterBase64,
    gitCommitMessage,
    gitCommitSubmitting,
    gitMostChangedItemId,
    setGitCommitMessage,
    handleGitRowClick,
    refreshGitStatus,
    insertGitChangeContext,
    submitGitCommit,
    stageGitFile,
    unstageGitFile,
  } = useGitChanges({
    t: props.t,
    instanceId: props.instanceId,
    rightPanelTab,
    worktreeSlug: worktreeSlugForViewer,
    isPhoneLayout: props.isPhoneLayout,
    promptInputApi: props.promptInputApi,
    closeGitList: () => setGitChangesListOpen(false),
  })

  createEffect(() => {
    worktreeSlugForViewer()
    setBrowserPath(".")
    setBrowserEntries(null)
    setBrowserError(null)
    setBrowserSelectedPath(null)
    setBrowserSelectedContent(null)
    setBrowserSelectedError(null)
    setBrowserSelectedLoading(false)
    setBrowserSelectedBase64(null)
  })

  const normalizeBrowserPath = (input: string) => {
    const raw = String(input || ".").trim()
    if (!raw || raw === "./") return "."
    const cleaned = raw.replace(/\\/g, "/").replace(/\/+$/, "")
    return cleaned === "" ? "." : cleaned
  }

  const getParentPath = (path: string): string | null => {
    const current = normalizeBrowserPath(path)
    if (current === ".") return null
    const parts = current.split("/").filter(Boolean)
    parts.pop()
    return parts.length ? parts.join("/") : "."
  }

  const loadBrowserEntries = async (path: string) => {
    const normalized = normalizeBrowserPath(path)
    const cached = normalized === "." ? getCachedFileList(props.instanceId, normalized) : null
    if (cached) {
      setBrowserPath(normalized)
      setBrowserEntries(cached as unknown as FileNode[])
      setBrowserError(null)
    } else {
      setBrowserLoading(true)
      setBrowserError(null)
    }
    try {
      const nodes = await requestData<FileNode[]>(browserClient().file.list({ path: normalized, ...(await fileWorkspacePayload()) }), "file.list")
      setBrowserPath(normalized)
      const listed = Array.isArray(nodes) ? nodes : []
      let entries: BrowserFileNode[] = listed
      try {
        const withTimes = await serverApi.listWorkspaceFiles(props.instanceId, normalized, {
          worktree: worktreeSlugForViewer(),
        })
        entries = mergeFileModifiedAt(listed, withTimes)
      } catch {
        entries = listed
      }
      setBrowserEntries(entries)
      if (normalized === ".") {
        setCachedFileList(props.instanceId, normalized, entries)
      }
    } catch (error) {
      if (!cached) {
        setBrowserError(error instanceof Error ? error.message : "Failed to load files")
        setBrowserEntries([])
      }
    } finally {
      setBrowserLoading(false)
    }
  }

  const openBrowserFile = async (path: string) => {
    setBrowserSelectedPath(path)
    setBrowserSelectedLoading(true)
    setBrowserSelectedError(null)
    setBrowserSelectedContent(null)
    setBrowserSelectedDirty(false)
    setBrowserSelectedOriginalContent(null)
    setBrowserSelectedBase64(null)

    // Phone: treat file selection as a commit action and close the overlay.
    if (props.isPhoneLayout()) {
      setFilesListOpen(false)
    }
    try {
      const content = await requestData<FileContent>(browserClient().file.read({ path, ...(await fileWorkspacePayload()) }), "file.read")
      const type = (content as any)?.type
      const encoding = (content as any)?.encoding
      if (type && type !== "text") {
        if (isImagePath(path)) {
          const base64 = String((content as any)?.content || "")
          if (base64) {
            const mimeType = (content as any)?.mimeType || detectImageMime(path) || "image/png"
            setBrowserSelectedBase64({
              base64,
              mimeType,
              sizeBytes: approximateBinarySizeFromBase64(base64),
              path,
            })
            return
          }
        }
        throw new Error("Binary file cannot be displayed")
      }
      if (encoding === "base64") {
        if (isImagePath(path)) {
          const base64 = String((content as any)?.content || "")
          if (base64) {
            const mimeType = (content as any)?.mimeType || detectImageMime(path) || "image/png"
            setBrowserSelectedBase64({
              base64,
              mimeType,
              sizeBytes: approximateBinarySizeFromBase64(base64),
              path,
            })
            return
          }
        }
        throw new Error("Binary file cannot be displayed")
      }
      const text = (content as any)?.content
      if (typeof text !== "string") {
        throw new Error("Unsupported file type")
      }
      setBrowserSelectedContent(text)
      setBrowserSelectedOriginalContent(text) // Track original content for conflict detection
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
    } finally {
      setBrowserSelectedLoading(false)
    }
  }

  const saveBrowserFile = async (content: string): Promise<boolean> => {
    const path = browserSelectedPath()
    if (!path) return false

    // Check for conflict: agent edited file while user was editing
    const originalContent = browserSelectedOriginalContent()
    if (originalContent !== null) {
      try {
        const currentDiskContent = await requestData<FileContent>(
          browserClient().file.read({ path, ...(await fileWorkspacePayload()) }),
          "file.read",
        )
        const diskContent = (currentDiskContent as any)?.content

        // If disk content differs from what we originally loaded (agent edit)
        // AND differs from user's current edits, we have a conflict
        if (diskContent !== originalContent && diskContent !== content) {
          const confirmed = await showConfirmDialog(
            props.t("instanceShell.rightPanel.actions.conflict.message", { path }),
            {
              variant: "warning",
              confirmLabel: props.t("instanceShell.rightPanel.actions.conflict.confirmLabel"),
              cancelLabel: props.t("instanceShell.rightPanel.actions.conflict.cancelLabel"),
              dismissible: false,
            },
          )
          if (!confirmed) {
            return false
          }
          // User chose to overwrite, proceed with save
        }
      } catch {
        // If we can't check for conflict, proceed with save
      }
    }

    setBrowserSelectedSaving(true)
    try {
      await serverApi.writeWorkspaceFile(props.instanceId, path, content, { worktree: worktreeSlugForViewer() })
      setBrowserSelectedContent(content)
      setBrowserSelectedOriginalContent(content) // Update original to match saved
      setBrowserSelectedDirty(false)
      showToastNotification({
        message: props.t("instanceShell.rightPanel.toast.saveSuccess"),
        variant: "success",
      })
      return true
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to save file")
      showToastNotification({
        message: props.t("instanceShell.rightPanel.toast.saveError"),
        variant: "error",
      })
      return false
    } finally {
      setBrowserSelectedSaving(false)
    }
  }

  const handleBrowserFileChange = (content: string) => {
    setBrowserSelectedContent(content)
    setBrowserSelectedDirty(true)
  }

  const uploadBrowserFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (!files.length) return
    setBrowserUploading(true)
    try {
      const payload = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          contentsBase64: await fileToBase64(file),
        })),
      )
      const result = await serverApi.uploadWorkspaceFiles(props.instanceId, payload, {
        path: browserPath(),
        worktree: worktreeSlugForViewer(),
      })
      showToastNotification({
        message: props.t("instanceShell.filesShell.toast.uploadSuccess", { count: result.uploaded.length }),
        variant: "success",
      })
      await loadBrowserEntries(browserPath())
    } catch (error) {
      showToastNotification({
        message: error instanceof Error ? error.message : props.t("instanceShell.filesShell.toast.uploadError"),
        variant: "error",
      })
    } finally {
      setBrowserUploading(false)
    }
  }

  const handleOpenBrowserFileRequest = async (path: string) => {
    if (browserSelectedDirty()) {
      const confirmed = await showConfirmDialog(
        props.t("instanceShell.rightPanel.actions.saveConfirm.message", { path: browserSelectedPath() || "" }),
        {
          variant: "warning",
          confirmLabel: props.t("instanceShell.rightPanel.actions.saveConfirm.confirmLabel"),
          cancelLabel: props.t("instanceShell.rightPanel.actions.saveConfirm.cancelLabel"),
          dismissible: false,
        },
      )
      if (confirmed) {
        const saveSuccess = await saveBrowserFile(browserSelectedContent() || "")
        if (!saveSuccess) {
          // Save failed - stay on current file, error toast already shown
          return
        }
      } else {
        // User chose not to save - clear dirty state and discard edits
        setBrowserSelectedDirty(false)
      }
    }
    await openBrowserFile(path)
  }

  createEffect(() => {
    if (rightPanelTab() !== "files") return
    if (browserLoading()) return
    if (browserEntries() !== null) return
    void loadBrowserEntries(browserPath())
  })

  createEffect(() => {
    if (rightPanelTab() === "files") return
    setBrowserSelectedContent(null)
    setBrowserSelectedLoading(false)
    setBrowserSelectedError(null)
    setBrowserSelectedDirty(false)
    setBrowserSelectedBase64(null)
  })

  const toggleFilesList = () => {
    setFilesListTouched(true)
    setFilesListOpen((current) => {
      const next = !current
      persistListOpen("files", next)
      return next
    })
  }

  const toggleGitList = () => {
    setGitChangesListTouched(true)
    setGitChangesListOpen((current) => {
      const next = !current
      persistListOpen("git-changes", next)
      return next
    })
  }

  const refreshFilesTab = async () => {
    // Prompt for confirmation if file has unsaved changes
    if (browserSelectedDirty()) {
      const confirmed = await showConfirmDialog(
        props.t("instanceShell.rightPanel.actions.refreshDirty.message"),
        {
          variant: "warning",
          confirmLabel: props.t("instanceShell.rightPanel.actions.refreshDirty.confirmLabel"),
          cancelLabel: props.t("instanceShell.rightPanel.actions.refreshDirty.cancelLabel"),
          dismissible: false,
        },
      )
      if (!confirmed) {
        return
      }
    }

    void loadBrowserEntries(browserPath())
    const selected = browserSelectedPath()
    if (selected) {
      // Refresh file content without altering overlay state.
      setBrowserSelectedLoading(true)
      setBrowserSelectedError(null)
      try {
        const content = await requestData<FileContent>(browserClient().file.read({ path: selected, ...(await fileWorkspacePayload()) }), "file.read")
        const type = (content as any)?.type
        const encoding = (content as any)?.encoding
        if (type && type !== "text") {
          if (isImagePath(selected)) {
            const base64 = String((content as any)?.content || "")
            if (base64) {
              const mimeType = (content as any)?.mimeType || detectImageMime(selected) || "image/png"
              setBrowserSelectedBase64({
                base64,
                mimeType,
                sizeBytes: approximateBinarySizeFromBase64(base64),
                path: selected,
              })
              return
            }
          }
          throw new Error("Binary file cannot be displayed")
        }
        if (encoding === "base64") {
          if (isImagePath(selected)) {
            const base64 = String((content as any)?.content || "")
            if (base64) {
              const mimeType = (content as any)?.mimeType || detectImageMime(selected) || "image/png"
              setBrowserSelectedBase64({
                base64,
                mimeType,
                sizeBytes: approximateBinarySizeFromBase64(base64),
                path: selected,
              })
              return
            }
          }
          throw new Error("Binary file cannot be displayed")
        }
        setBrowserSelectedBase64(null)
        const text = (content as any)?.content
        if (typeof text !== "string") {
          throw new Error("Unsupported file type")
        }
        setBrowserSelectedContent(text)
        setBrowserSelectedOriginalContent(text) // Update original content after refresh
        setBrowserSelectedDirty(false) // Clear dirty after refresh
      } catch (error) {
        setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
      } finally {
        setBrowserSelectedLoading(false)
      }
    }
  }

  const browserParentPath = createMemo(() => getParentPath(browserPath()))
  const browserScopeKey = createMemo(() => `${props.instanceId}:${worktreeSlugForViewer()}`)
  const gitScopeKey = createMemo(() => `${props.instanceId}:git:${worktreeSlugForViewer()}`)

  const handleAccordionChange = (values: string[]) => {
    setRightPanelExpandedItems(values)
  }

  const tabClass = (tab: RightPanelTab) =>
    `right-panel-tab ${rightPanelTab() === tab ? "right-panel-tab-active" : "right-panel-tab-inactive"}`

  return (
    <div class="flex flex-col h-full" ref={props.setContentEl}>
      <div class="right-panel-tab-bar">
        <div class="tab-container">
          <div class="tab-strip-shortcuts text-primary">
            <Show when={props.rightDrawerState() === "floating-open"}>
              <IconButton
                size="small"
                color="inherit"
                aria-label={props.t("instanceShell.rightDrawer.toggle.close")}
                title={props.t("instanceShell.rightDrawer.toggle.close")}
                onClick={props.onCloseRightDrawer}
              >
                <MenuOpenIcon fontSize="small" sx={{ transform: "scaleX(-1)" }} />
              </IconButton>
            </Show>
            <Show when={!props.isPhoneLayout()}>
              <IconButton
                size="small"
                color="inherit"
                aria-label={props.rightPinned() ? props.t("instanceShell.rightDrawer.unpin") : props.t("instanceShell.rightDrawer.pin")}
                onClick={() => (props.rightPinned() ? props.onUnpinRightDrawer() : props.onPinRightDrawer())}
              >
                {props.rightPinned() ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
              </IconButton>
            </Show>
          </div>
          <div class="tab-scroll">
            <div class="tab-strip">
              <div class="tab-strip-tabs" role="tablist" aria-label={props.t("instanceShell.rightPanel.tabs.ariaLabel")}> 
                <button
                  type="button"
                  role="tab"
                  class={tabClass("git-changes")}
                  aria-selected={rightPanelTab() === "git-changes"}
                  onClick={() => setRightPanelTab("git-changes")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.gitChanges")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class={tabClass("files")}
                  aria-selected={rightPanelTab() === "files"}
                  onClick={() => setRightPanelTab("files")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.files")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class={tabClass("status")}
                  aria-selected={rightPanelTab() === "status"}
                  onClick={() => setRightPanelTab("status")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.status")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class={tabClass("wiki-lint")}
                  aria-selected={rightPanelTab() === "wiki-lint"}
                  onClick={() => setRightPanelTab("wiki-lint")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.wikiLint")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  class={tabClass("notify-history")}
                  aria-selected={rightPanelTab() === "notify-history"}
                  onClick={() => setRightPanelTab("notify-history")}
                >
                  <span class="tab-label">{props.t("instanceShell.rightPanel.tabs.notifyHistory")}</span>
                  <Show when={getUnreadCount() > 0}>
                    <span
                      class="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground"
                      aria-hidden="true"
                    >
                      {getUnreadCount() > 9 ? "9+" : getUnreadCount()}
                    </span>
                  </Show>
                </button>
              </div>

              <div class="tab-strip-spacer" />
            </div>
          </div>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto">
        <Show when={rightPanelTab() === "git-changes"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyGitChangesTab
              t={props.t}
              activeSessionId={props.activeSessionId}
              entries={gitStatusEntries}
              statusLoading={gitStatusLoading}
              statusError={gitStatusError}
              selectedItemId={gitSelectedItemId}
              selectedBulkItemIds={gitBulkSelectedItemIds}
              selectedLoading={gitSelectedLoading}
              selectedError={gitSelectedError}
              selectedBefore={gitSelectedBefore}
              selectedAfter={gitSelectedAfter}
              selectedAfterBase64={gitSelectedAfterBase64}
              mostChangedItemId={gitMostChangedItemId}
              scopeKey={gitScopeKey}
              diffViewMode={diffViewMode}
              diffContextMode={diffContextMode}
              diffWordWrapMode={diffWordWrapMode}
              onViewModeChange={setDiffViewMode}
              onContextModeChange={setDiffContextMode}
              onWordWrapModeChange={setDiffWordWrapMode}
              onRowClick={handleGitRowClick}
              onRefresh={() => void refreshGitStatus()}
              onInsertContext={insertGitChangeContext}
              onStageFile={stageGitFile}
              onUnstageFile={unstageGitFile}
              commitMessage={gitCommitMessage}
              commitSubmitting={gitCommitSubmitting}
              onCommitMessageInput={setGitCommitMessage}
              onSubmitCommit={() => void submitGitCommit()}
              branchLabel={gitChangesBranchLabel}
              stagedOpen={gitStagedOpen}
              unstagedOpen={gitUnstagedOpen}
              onToggleStagedOpen={() => {
                const next = !gitStagedOpen()
                setGitStagedOpen(next)
                persistGitSectionOpen("staged", next)
              }}
              onToggleUnstagedOpen={() => {
                const next = !gitUnstagedOpen()
                setGitUnstagedOpen(next)
                persistGitSectionOpen("unstaged", next)
              }}
              listOpen={gitChangesListOpen}
              onToggleList={toggleGitList}
              splitWidth={gitChangesSplitWidth}
              onResizeMouseDown={handleSplitResizeMouseDown("git-changes")}
              onResizeTouchStart={handleSplitResizeTouchStart("git-changes")}
              isPhoneLayout={props.isPhoneLayout}
            />
          </Suspense>
        </Show>

        <Show when={rightPanelTab() === "files"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyFilesTab
              t={props.t}
              browserPath={browserPath}
              browserEntries={browserEntries}
              browserLoading={browserLoading}
              browserError={browserError}
              browserSelectedPath={browserSelectedPath}
              browserSelectedContent={browserSelectedContent}
              browserSelectedLoading={browserSelectedLoading}
              browserSelectedError={browserSelectedError}
              browserSelectedDirty={browserSelectedDirty}
              browserSelectedSaving={browserSelectedSaving}
              browserSelectedBase64={browserSelectedBase64}
              wordWrapMode={filesWordWrapMode}
              parentPath={browserParentPath}
              scopeKey={browserScopeKey}
              onLoadEntries={(path: string) => void loadBrowserEntries(path)}
              onRequestOpenFile={(path: string) => void handleOpenBrowserFileRequest(path)}
              onRefresh={() => void refreshFilesTab()}
              uploading={browserUploading}
              onUploadFiles={(files: FileList | File[]) => void uploadBrowserFiles(files)}
              onSave={(content: string) => void saveBrowserFile(content)}
              onContentChange={(content: string) => handleBrowserFileChange(content)}
              onWordWrapModeChange={setFilesWordWrapMode}
              listOpen={filesListOpen}
              onToggleList={toggleFilesList}
              splitWidth={filesSplitWidth}
              onResizeMouseDown={handleSplitResizeMouseDown("files")}
              onResizeTouchStart={handleSplitResizeTouchStart("files")}
              isPhoneLayout={props.isPhoneLayout}
            />
          </Suspense>
        </Show>

        <Show when={rightPanelTab() === "status"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyStatusTab
              t={props.t}
              instanceId={props.instanceId}
              instance={props.instance}
              activeSessionId={props.activeSessionId}
              activeSession={props.activeSession}
              latestTodoState={props.latestTodoState}
              backgroundProcessList={props.backgroundProcessList}
              onOpenBackgroundOutput={props.onOpenBackgroundOutput}
              onStopBackgroundProcess={props.onStopBackgroundProcess}
              onTerminateBackgroundProcess={props.onTerminateBackgroundProcess}
              expandedItems={rightPanelExpandedItems}
              onExpandedItemsChange={handleAccordionChange}
            />
          </Suspense>
        </Show>

        <Show when={rightPanelTab() === "wiki-lint"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyWikiLintTab
              t={props.t}
              instanceId={props.instanceId}
            />
          </Suspense>
        </Show>

        <Show when={rightPanelTab() === "notify-history"}>
          <Suspense fallback={<RightPanelTabFallback />}>
            <LazyNotifyHistoryTab instanceId={props.instanceId} />
          </Suspense>
        </Show>
      </div>
    </div>
  )
}

export default RightPanel
