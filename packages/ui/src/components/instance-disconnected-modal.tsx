import { Dialog } from "@kobalte/core/dialog"
import { Show, Match, Switch } from "solid-js"
import { useI18n } from "../lib/i18n"
import {
  reconnecting,
  retryCount,
  lastError,
  starGuardToken,
  MAX_RETRIES,
  cancelReconnect,
  startReconnect,
} from "../stores/session-recovery"

interface InstanceDisconnectedModalProps {
  open: boolean
  folder?: string
  reason?: string
  onClose: () => void
}

export default function InstanceDisconnectedModal(props: InstanceDisconnectedModalProps) {
  const { t } = useI18n()

  const folderLabel = () => props.folder || t("instanceDisconnected.folderFallback")
  const reasonLabel = () => props.reason || t("instanceDisconnected.reasonFallback")

  const handleRetry = () => {
    const token = starGuardToken()
    if (token) {
      startReconnect(token)
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
                      current: String(retryCount()),
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
                    onClick={cancelReconnect}
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

                <div class="flex justify-end gap-2">
                  <Show when={starGuardToken()}>
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
