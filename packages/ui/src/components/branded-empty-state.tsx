import type { Component, JSX } from "solid-js"
import { useI18n } from "../lib/i18n"
import TokenizinLogo3D from "./tokenizin-logo-3d"
import { PRESTIX_LANDING_COPY, isPrestixSilo } from "../lib/silo-brand"

interface BrandedEmptyStateProps {
  title?: JSX.Element
  description: JSX.Element
  class?: string
  children?: JSX.Element
}

const BrandedEmptyState: Component<BrandedEmptyStateProps> = (props) => {
  const { t } = useI18n()

  return (
    <div class={`empty-state ${isPrestixSilo() ? "silo-prestix " : ""}${props.class ?? ""}`.trim()}>
      <div class="empty-state-content">
        <div class="flex flex-col items-center gap-3 mb-6">
          <TokenizinLogo3D
            width={192}
            height={192}
            alt={isPrestixSilo() ? PRESTIX_LANDING_COPY.logoAlt : t("messageSection.empty.logoAlt")}
            spin
          />
          <h1 class="empty-state-brand-title text-3xl font-semibold text-primary">
            {isPrestixSilo() ? PRESTIX_LANDING_COPY.brandTitle : t("messageSection.empty.brandTitle")}
          </h1>
        </div>
        {props.title ? <h3>{props.title}</h3> : null}
        <p>{props.description}</p>
        {props.children}
      </div>
    </div>
  )
}

interface BrandedFullWidthEmptyStateProps {
  title?: JSX.Element
  description: JSX.Element
  class?: string
  children?: JSX.Element
  /**
   * Layout variant:
   * - "centered" (default): full-width content with padding, centered
   * - "full-bleed": removes all padding for edge-to-edge landing page layout
   */
  variant?: "centered" | "full-bleed"
}

/**
 * Full-width variant of BrandedEmptyState for the compact suggestion bar
 * layout. Removes the `max-w-sm` constraint so children can span full width.
 *
 * Use variant="full-bleed" for the landing page to remove all padding
 * and span the entire available body.
 */
export const BrandedFullWidthEmptyState: Component<BrandedFullWidthEmptyStateProps> = (props) => {
  const { t } = useI18n()
  const isFullBleed = props.variant === "full-bleed"

  const stateClass = isFullBleed
    ? "empty-state--landing"
    : "empty-state--full-width"

  const contentClass = isFullBleed
    ? "empty-state-content--landing"
    : "empty-state-content--full-width"

  return (
    <div class={`empty-state ${stateClass} ${isPrestixSilo() ? "silo-prestix " : ""}${props.class ?? ""}`.trim()}>
      <div class={`empty-state-content ${contentClass}`}>
        <div class="flex flex-col items-center gap-3 mb-6">
          <TokenizinLogo3D
            width={192}
            height={192}
            alt={isPrestixSilo() ? PRESTIX_LANDING_COPY.logoAlt : t("messageSection.empty.logoAlt")}
            spin
          />
          <h1 class="empty-state-brand-title text-3xl font-semibold text-primary">
            {isPrestixSilo() ? PRESTIX_LANDING_COPY.brandTitle : t("messageSection.empty.brandTitle")}
          </h1>
        </div>
        {props.title ? <h3>{props.title}</h3> : null}
        <p>{props.description}</p>
        {props.children}
      </div>
    </div>
  )
}

export default BrandedEmptyState
