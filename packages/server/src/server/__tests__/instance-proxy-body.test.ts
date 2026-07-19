import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { FastifyRequest } from "fastify"

import {
  instanceProxyAllowsBody,
  isEffectivelyEmptyProxyBody,
  isInstanceSessionCreatePath,
  resolveInstanceProxyBody,
  resolveInstanceProxyContentType,
  resolveInstanceProxyForwardContentType,
} from "../instance-proxy-body"

function mockRequest(partial: Partial<FastifyRequest>): FastifyRequest {
  return partial as FastifyRequest
}

describe("instance proxy body helpers", () => {
  it("allows PATCH bodies and blocks GET", () => {
    assert.equal(instanceProxyAllowsBody("PATCH"), true)
    assert.equal(instanceProxyAllowsBody("GET"), false)
  })

  it("forwards non-empty buffers and plain objects", () => {
    const buffer = Buffer.from('{"provider":{}}', "utf8")
    assert.equal(
      resolveInstanceProxyBody(mockRequest({ body: buffer }))?.toString("utf8"),
      '{"provider":{}}',
    )
    assert.equal(resolveInstanceProxyBody(mockRequest({ body: Buffer.alloc(0) })), undefined)
    assert.equal(resolveInstanceProxyBody(mockRequest({ body: { model: "ollama/gemma4:latest" } })), '{"model":"ollama/gemma4:latest"}')
  })

  it("treats empty JSON bodies as absent except session create", () => {
    assert.equal(isEffectivelyEmptyProxyBody(Buffer.from("{}", "utf8")), true)
    assert.equal(isEffectivelyEmptyProxyBody(Buffer.from("[]", "utf8")), true)
    assert.equal(isEffectivelyEmptyProxyBody({}), true)
    assert.equal(resolveInstanceProxyBody(mockRequest({ body: Buffer.from("{}", "utf8") })), undefined)
    assert.equal(resolveInstanceProxyBody(mockRequest({ body: {} })), undefined)
    assert.equal(
      resolveInstanceProxyBody(
        mockRequest({ url: "/workspaces/x/instance/session", body: Buffer.from("{}", "utf8") }),
      ),
      "{}",
    )
    assert.equal(
      resolveInstanceProxyBody(mockRequest({ url: "/workspaces/x/instance/session", body: {} })),
      "{}",
    )
  })

  it("detects session create paths", () => {
    assert.equal(isInstanceSessionCreatePath("/workspaces/x/instance/session"), true)
    assert.equal(isInstanceSessionCreatePath("/workspaces/x/instance/session/"), true)
    assert.equal(isInstanceSessionCreatePath("/workspaces/x/instance/session/ses_1/prompt_async"), false)
  })

  it("forwards prompt_async bodies unchanged", () => {
    const payload = '{"parts":[{"type":"text","text":"hi"}]}'
    assert.equal(
      resolveInstanceProxyBody(
        mockRequest({
          url: "/workspaces/x/instance/session/ses_1/prompt_async",
          body: Buffer.from(payload, "utf8"),
        }),
      )?.toString("utf8"),
      payload,
    )
  })

  it("reads content-type header and defaults forward type to JSON", () => {
    assert.equal(
      resolveInstanceProxyContentType(mockRequest({ headers: { "content-type": "application/json" } })),
      "application/json",
    )
    assert.equal(
      resolveInstanceProxyForwardContentType(mockRequest({ headers: {} }), '{"title":"x"}'),
      "application/json",
    )
    assert.equal(resolveInstanceProxyForwardContentType(mockRequest({ headers: {} }), undefined), undefined)
  })
})
