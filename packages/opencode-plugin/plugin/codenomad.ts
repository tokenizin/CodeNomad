import type { PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadClient, createCodeNomadRequester, getCodeNomadConfig } from "./lib/client.js"
import { createBackgroundProcessTools } from "./lib/background-process.js"

let voiceModeEnabled = false

export async function CodeNomadPlugin(input: PluginInput): Promise<{
  tool: ReturnType<typeof createBackgroundProcessTools> & {
    stop_voice_mode: ReturnType<typeof tool>
  }
  "chat.message": CodeNomadChatMessageHook
  event: CodeNomadEventHook
}> {
  const config = getCodeNomadConfig()
  const client = createCodeNomadClient(config)
  const requester = createCodeNomadRequester(config)
  const backgroundProcessTools = createBackgroundProcessTools(config, { baseDir: input.directory })

  await client.startEvents((event) => {
    if (event.type === "codenomad.ping") {
      void client.postEvent({
        type: "codenomad.pong",
        properties: {
          ts: Date.now(),
          pingTs: (event.properties as any)?.ts,
        },
      }).catch(() => {})
      return
    }

    if (event.type === "codenomad.voiceMode") {
      voiceModeEnabled = Boolean((event.properties as { enabled?: unknown } | undefined)?.enabled)
    }
  })

  return {
    tool: {
      ...backgroundProcessTools,
      stop_voice_mode: tool({
        description:
          "Disable voice conversation mode and return to text-only input. " +
          "Call this when the user says 'stop', 'end conversation', 'go back to text', " +
          "or otherwise indicates they want to end the voice conversation.",
        args: {},
        async execute() {
          await requester.requestVoid("/voice-mode", {
            method: "POST",
            body: JSON.stringify({ enabled: false }),
          })
          voiceModeEnabled = false
          return "Voice conversation mode disabled. User will now interact via text input only."
        },
      }),
    },
    async "chat.message"(_input: { sessionID: string }, output: { message: { system?: string } }) {
      if (!voiceModeEnabled) {
        return
      }

      output.message.system = [output.message.system, buildVoiceModePrompt()].filter(Boolean).join("\n\n")
    },
    async event(input: { event: any }) {
      const opencodeEvent = input?.event
      if (!opencodeEvent || typeof opencodeEvent !== "object") return

    },
  }
}

type CodeNomadChatMessageHook = (
  _input: { sessionID: string },
  output: { message: { system?: string } },
) => Promise<void>

type CodeNomadEventHook = (input: { event: any }) => Promise<void>

function buildVoiceModePrompt(): string {
  return [
    "Voice conversation mode is enabled.",
    "Prepend your reply with a fenced code block using language `spoken`.",
    "The `spoken` block should be the natural conversational reply you would say out loud to the user. It should be a concise spoken gist of the full response in 2 to 4 natural sentences.",
    "In the spoken block, summarize the main outcome, recommendation, or next step. Sound conversational and natural, not like a document summary.",
    "Do not include code, bullet lists, markdown formatting, or long technical detail in the spoken block.",
    "Do not add generic phrases about whether the user should read more.",
    "Only mention additional written detail when there is something specific that may matter for the user's next response, such as a tradeoff, caveat, risk, open question, exact diff, or test result.",
    "When referring to that written detail, say `below` or `in the message` rather than `detailed section`.",
    "",
    "STOPPING VOICE MODE: If the user says 'stop', 'end conversation', 'go back to text', or similar, call the `stop_voice_mode` tool immediately. Do NOT respond with a `spoken` block \u2014 just call the tool and acknowledge with a plain text message.",
    "",
    "After the `spoken` block, continue with your normal detailed response.",
    "Example:",
    "```spoken\nI implemented the relay-based voice-mode flow and it works with the current plugin bridge. The reconnect caveat is explained below.\n```",
  ].join("\n\n")
}
