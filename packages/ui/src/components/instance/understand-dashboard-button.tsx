import { Show, createResource, type Component } from "solid-js"
import IconButton from "@suid/material/IconButton"
import AutoAwesome from "@suid/icons-material/AutoAwesome"
import { useI18n } from "../../lib/i18n"
import { buildAbsoluteUrl, serverApi } from "../../lib/api-client"
import { openExternalUrl } from "../../lib/external-url"
import { getLogger } from "../../lib/logger"

const log = getLogger("api")

const DASHBOARD_PATH = "/understand"

/**
 * One probe per page load, shared by every instance shell. A failed probe is dropped so the
 * next mount retries; while it is pending or failed the button stays hidden.
 */
let availabilityProbe: Promise<boolean> | null = null

function probeDashboardAvailability(): Promise<boolean> {
  if (!availabilityProbe) {
    availabilityProbe = serverApi
      .fetchUnderstandDashboardStatus()
      .then((status) => status.available)
      .catch((error) => {
        log.warn("Understand-Anything dashboard probe failed", error)
        availabilityProbe = null
        return false
      })
  }
  return availabilityProbe
}

/** Absolute URL of the dashboard for a project, honouring the configured API base. */
export function buildUnderstandDashboardUrl(projectRoot?: string): string {
  const query = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ""
  return buildAbsoluteUrl(`${DASHBOARD_PATH}${query}`)
}

/** Opens the Understand-Anything dashboard for the instance's project; hidden when unavailable. */
export const UnderstandDashboardButton: Component<{ projectRoot?: string }> = (props) => {
  const { t } = useI18n()
  const [available] = createResource(probeDashboardAvailability)

  return (
    <Show when={available() === true}>
      <IconButton
        color="inherit"
        onClick={() => void openExternalUrl(buildUnderstandDashboardUrl(props.projectRoot), "understand-dashboard")}
        aria-label={t("instanceShell.understandAnything.open")}
        size="small"
        title={t("instanceShell.understandAnything.title")}
      >
        <AutoAwesome fontSize="small" />
      </IconButton>
    </Show>
  )
}
