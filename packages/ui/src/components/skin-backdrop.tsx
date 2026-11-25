import { Show, type Component } from "solid-js"
import StarWorldGlobe from "./starworld-globe"
import { activeUiSkin } from "../lib/ui-skin"

/**
 * Backdrop for skinned instances (CODENOMAD_UI_SKIN): a large, faint, slowly turning gold globe behind the landing
 * page, the way matriza.vercel.app sets its hero over a globe. The spinning Tokenizin logo stays in front of it.
 * Renders nothing for instances without a skin, so their landing page is unchanged.
 */
const SkinBackdrop: Component = () => (
  <Show when={activeUiSkin() === "matriza"}>
    <div class="skin-backdrop" aria-hidden="true">
      <StarWorldGlobe size={880} rotationSpeed={0.03} class="skin-backdrop-globe" />
    </div>
  </Show>
)

export default SkinBackdrop
