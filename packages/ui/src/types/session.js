export function getIdleSinceForStatusTransition(previousStatus, nextStatus, previousIdleSince, now = Date.now()) {
    if (nextStatus !== "idle") {
        return null;
    }
    if (previousStatus && previousStatus !== "idle") {
        return now;
    }
    return previousIdleSince ?? null;
}
export function mapSdkSessionStatus(status) {
    if (!status || status.type === "idle") {
        return "idle";
    }
    // "busy" and "retry" both mean there's active work.
    return "working";
}
export function mapSdkSessionRetry(status) {
    if (!status || status.type !== "retry") {
        return null;
    }
    return {
        attempt: typeof status.attempt === "number" ? status.attempt : 1,
        message: typeof status.message === "string" ? status.message : "",
        next: typeof status.next === "number" ? status.next : Date.now(),
    };
}
// Adapter function to convert SDK Session to client Session
export function createClientSession(sdkSession, instanceId, agent = "", model = { providerId: "", modelId: "" }, status = "idle") {
    return {
        ...sdkSession,
        instanceId,
        parentId: sdkSession.parentID || null,
        agent,
        model,
        status,
        idleSince: null,
    };
}
/**
 * Matches OpenCode TUI's primary-agent visibility rule: visible iff not a subagent and not hidden.
 */
export function isSelectablePrimaryAgent(agent) {
    return !agent.hidden && agent.mode !== "subagent";
}
export function getSelectableAgentsForSession(agentList, currentAgentName, isChildSession) {
    if (!isChildSession) {
        return agentList.filter(isSelectablePrimaryAgent);
    }
    const visibleAgents = agentList.filter((agent) => !agent.hidden);
    const currentHiddenAgent = agentList.find((agent) => agent.hidden && agent.name === currentAgentName);
    return currentHiddenAgent && !visibleAgents.some((agent) => agent.name === currentHiddenAgent.name)
        ? [...visibleAgents, currentHiddenAgent]
        : visibleAgents;
}
