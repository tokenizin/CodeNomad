import assert from "node:assert/strict"
import { describe, it as test } from "node:test"
import { LocalEngineReply, workflowSessionRecord } from "./local-engine"

describe("background workflows in the live reply", () => {
  const start = { type: "workflow_start", workflowId: "wf_1", sessionId: "ses_lcl_wf_1", title: "Workflow Run: T.md", taskPath: "tasks/todo/T/T.md", track: "implementation" }

  test("a workflow_start is handed out once, and does not change the visible reply", () => {
    const reply = new LocalEngineReply()
    assert.equal(reply.apply({ type: "tool", id: "w1", name: "nomadflow_run_workflow", input: {} }), true)
    assert.equal(reply.apply(start), false)
    const fresh = reply.takeNewWorkflows()
    assert.equal(fresh.length, 1)
    assert.deepEqual({ workflowId: fresh[0].workflowId, sessionId: fresh[0].sessionId, title: fresh[0].title, taskPath: fresh[0].taskPath, track: fresh[0].track }, { workflowId: "wf_1", sessionId: "ses_lcl_wf_1", title: "Workflow Run: T.md", taskPath: "tasks/todo/T/T.md", track: "implementation" })
    assert.deepEqual(reply.takeNewWorkflows(), [])
    // The same event again (or a second workflow) only adds what is new.
    reply.apply(start)
    reply.apply({ ...start, workflowId: "wf_2", sessionId: "ses_lcl_wf_2" })
    assert.deepEqual(reply.takeNewWorkflows().map((w) => w.sessionId), ["ses_lcl_wf_2"])
  })

  test("the card stays a plain tool call: no child session is linked to it", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "tool", id: "w1", name: "nomadflow_run_workflow", input: { task_path: "t.md" } })
    reply.apply(start)
    reply.apply({ type: "tool_result", id: "w1", name: "nomadflow_run_workflow", output: "SUCCESS: Workflow Runner session started.", isError: false })
    const card = reply.parts[0]
    assert.ok(card.type === "tool" && card.tool === "nomadflow_run_workflow" && card.status === "completed")
    assert.ok(!(card.type === "tool" && card.childSessionId))
  })

  test("an event without a session id is ignored", () => {
    const reply = new LocalEngineReply()
    reply.apply({ type: "workflow_start", workflowId: "wf_1" })
    assert.deepEqual(reply.takeNewWorkflows(), [])
  })

  test("the runner's session is an ordinary top-level session of the workflow_runner agent", () => {
    const reply = new LocalEngineReply()
    reply.apply(start)
    const record = workflowSessionRecord({ ...reply.takeNewWorkflows()[0], managerSessionId: "ses_lcl_mgr" }, "/work")
    assert.deepEqual({ id: record.id, folder: record.folder, agent: record.agent, kind: record.kind, title: record.title }, { id: "ses_lcl_wf_1", folder: "/work", agent: "workflow_runner", kind: "workflow", title: "Workflow Run: T.md" })
    assert.equal(record.parentId, undefined)
    assert.equal(record.workflow?.managerSessionId, "ses_lcl_mgr")
    assert.equal(record.workflow?.status, "running")
    assert.equal(record.workflow?.taskPath, "tasks/todo/T/T.md")
  })
})
