import { Component, Show, createMemo } from "solid-js"
import { Shield } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { isWebHost } from "../lib/runtime-env"
import { starGuardReturnHref } from "../lib/starguard-auth"

function shouldShowStarGuardBackLink(): boolean {
  if (typeof window === "undefined") return false
  if (!isWebHost()) return false
  const host = window.location.hostname
  return host !== "localhost" && host !== "127.0.0.1"
}

const StarGuardBackLink: Component = () => {
  const { t } = useI18n()
  const visible = createMemo(() => shouldShowStarGuardBackLink())

  return (
    <Show when={visible()}>
      <a
        href={starGuardReturnHref()}
        class="new-tab-button starguard-back-button"
        title={t("instanceTabs.starguardBack.title")}
        aria-label={t("instanceTabs.starguardBack.ariaLabel")}
      >
        <Shield class="w-4 h-4" />
      </a>
    </Show>
  )
}

export default StarGuardBackLink
