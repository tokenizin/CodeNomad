import { Show, type Component } from "solid-js"

import { useI18n } from "../../../../lib/i18n"
import { MAX_PREVIEW_BYTES } from "./fileTypes"

export interface ImagePreviewProps {
  base64: string
  mimeType: string
  sizeBytes: number
  path: string
  onOpenExternally?: (path: string) => void
}

export const ImagePreview: Component<ImagePreviewProps> = (props) => {
  const { t } = useI18n()

  const handleOpenExternally = () => {
    props.onOpenExternally?.(props.path)
  }

  return (
    <div class="codenomad-image-preview-container" data-image-path={props.path}>
      <Show
        when={props.sizeBytes <= MAX_PREVIEW_BYTES}
        fallback={
          <div class="codenomad-image-preview-too-large">
            <p class="codenomad-image-preview-too-large-text">
              {t("instanceShell.filesShell.imagePreview.tooLarge")}
            </p>
            <button
              type="button"
              class="file-viewer-toolbar-button"
              onClick={handleOpenExternally}
              disabled={!props.onOpenExternally}
            >
              {t("instanceShell.filesShell.imagePreview.openExternally")}
            </button>
          </div>
        }
      >
        <img
          src={`data:${props.mimeType};base64,${props.base64}`}
          alt={props.path}
          class="codenomad-image-preview"
        />
      </Show>
    </div>
  )
}

export default ImagePreview
