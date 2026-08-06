import { Dialog } from "@kobalte/core/dialog"
import { Show, Match, Switch } from "solid-js"
import { useI18n } from "../lib/i18n"
import { isReconnecting, getRetryCount, getLastError, MAX_RETRIES, cancelReconnect } from "../stores/session-recovery"
import { retryInstanceReconnect } from "../stores/instances"

interface InstanceDisconnectedModalProps {
  open: boolean
  instanceId: string | null
  folder?: string
  reason?: string
  onClose: () => void
}

export default function InstanceDisconnectedModal(props: InstanceDisconnectedModalProps) {
  const { t } = useI18n()

  const folderLabel = () => props.folder || t("instanceDisconnected.folderFallback")
  const reasonLabel = () => props.reason || t("instanceDisconnected.reasonFallback")

  const reconnecting = () => (props.instanceId ? isReconnecting(props.instanceId) : false)
  const lastError = () => (props.instanceId ? getLastError(props.instanceId) : null)

  // +1 because retryCount is incremented after each attempt's sleep,
  // so during attempt N the counter is N-1.
  const displayAttempt = () => (props.instanceId ? getRetryCount(props.instanceId) + 1 : 1)

  const handleRetry = () => {
    if (props.instanceId) {
      void retryInstanceReconnect(props.instanceId)
    }
  }

  const handleCancel = () => {
    if (props.instanceId) {
      cancelReconnect(props.instanceId)
    }
  }

  return (
    <Dialog open={props.open} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-md p-6 flex flex-col gap-6">
            <Switch>
              {/* ── Reconnecting state ── */}
              <Match when={reconnecting()}>
                <div>
                  <Dialog.Title class="text-xl font-semibold text-primary flex items-center gap-2">
                    {t("instanceDisconnected.reconnecting")}
                    <span class="status-dot ready animate-pulse" aria-hidden="true" />
                  </Dialog.Title>
                  <Dialog.Description class="text-sm text-secondary mt-2">
                    {t("instanceDisconnected.reconnectAttempt", {
                      current: String(displayAttempt()),
                      max: String(MAX_RETRIES),
                    })}
                  </Dialog.Description>
                </div>

                <Show when={lastError()}>
                  <div class="rounded-lg border border-base bg-surface-secondary p-4 text-sm">
                    <p class="font-medium text-primary">
                      {t("instanceDisconnected.reconnectFailed")}
                    </p>
                    <p class="mt-2 text-secondary break-words">{lastError()}</p>
                  </div>
                </Show>

                {/* Buttons: [Close secondary] [Cancel primary] — consistent order */}
                <div class="flex justify-end gap-2">
                  <button
                    type="button"
                    class="selector-button selector-button-secondary"
                    onClick={props.onClose}
                  >
                    {t("instanceDisconnected.actions.closeInstance")}
                  </button>
                  <button
                    type="button"
                    class="selector-button selector-button-primary"
                    onClick={handleCancel}
                  >
                    {t("instanceDisconnected.actions.cancelReconnect")}
                  </button>
                </div>
              </Match>

              {/* ── Disconnected state (original) ── */}
              <Match when={!reconnecting()}>
                <div>
                  <Dialog.Title class="text-xl font-semibold text-primary">
                    {t("instanceDisconnected.title")}
                  </Dialog.Title>
                  <Dialog.Description class="text-sm text-secondary mt-2 break-words">
                    {t("instanceDisconnected.description", { folder: folderLabel() })}
                  </Dialog.Description>
                </div>

                <div class="rounded-lg border border-base bg-surface-secondary p-4 text-sm text-secondary">
                  <p class="font-medium text-primary">
                    {t("instanceDisconnected.details.title")}
                  </p>
                  <p class="mt-2 text-secondary">{reasonLabel()}</p>
                  {props.folder && (
                    <p class="mt-2 text-secondary">
                      {t("instanceDisconnected.details.folderLabel")}{" "}
                      <span class="font-mono text-primary break-all">{props.folder}</span>
                    </p>
                  )}
                </div>

                {/* Buttons: [Retry secondary] [Close primary] — consistent order */}
                <div class="flex justify-end gap-2">
                  <Show when={props.instanceId}>
                    <button
                      type="button"
                      class="selector-button selector-button-secondary"
                      onClick={handleRetry}
                    >
                      {t("instanceDisconnected.actions.retryReconnect")}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="selector-button selector-button-primary"
                    onClick={props.onClose}
                  >
                    {t("instanceDisconnected.actions.closeInstance")}
                  </button>
                </div>
              </Match>
            </Switch>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}
