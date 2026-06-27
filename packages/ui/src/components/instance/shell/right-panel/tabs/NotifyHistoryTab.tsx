import type { Component } from "solid-js"
import NotifyHistoryPanel from "../../../../notify-history-panel"

interface NotifyHistoryTabProps {
  instanceId: string
}

const NotifyHistoryTab: Component<NotifyHistoryTabProps> = (props) => (
  <div class="status-tab-container flex flex-col h-full min-h-0">
    <NotifyHistoryPanel instanceId={props.instanceId} embedded />
  </div>
)

export default NotifyHistoryTab
