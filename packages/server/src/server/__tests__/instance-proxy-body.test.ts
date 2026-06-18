import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { FastifyRequest } from "fastify"

import {
  instanceProxyAllowsBody,
  resolveInstanceProxyBody,
  resolveInstanceProxyContentType,
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

  it("reads content-type header", () => {
    assert.equal(
      resolveInstanceProxyContentType(mockRequest({ headers: { "content-type": "application/json" } })),
      "application/json",
    )
  })
})
