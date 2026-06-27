/**
 * Mirror of StarGuard src/lib/tokidapp/speech-sanitize.ts for server-side voice text.
 * Includes word-spacing recovery for ASR transcripts that occasionally
 * arrive without spaces between words (e.g. "Thanksforpointingthatout").
 */

/**
 * Common conversational English words used by restoreWordSpacing() to
 * greedily split concatenated ASR output into readable text.
 */
const COMMON_WORDS: Set<string> = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'every',
  'each', 'all', 'both', 'few', 'many', 'much', 'no', 'none', 'several',
  'such', 'enough', 'more', 'most', 'less', 'little', 'least', 'own',
  'same', 'other', 'another', 'next', 'last', 'previous', 'final',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'mine',
  'yours', 'hers', 'ours', 'theirs', 'myself', 'yourself', 'himself',
  'herself', 'itself', 'ourselves', 'themselves', 'who', 'whom', 'whose',
  'which', 'what', 'that', 'this', 'anyone', 'everyone', 'someone',
  'anybody', 'everybody', 'somebody', 'nobody', 'anything', 'everything',
  'something', 'nothing', 'anywhere', 'everywhere', 'somewhere', 'nowhere',
  'about', 'above', 'across', 'after', 'against', 'along', 'among',
  'around', 'at', 'before', 'behind', 'below', 'beneath', 'beside',
  'between', 'beyond', 'by', 'down', 'during', 'except', 'for', 'from',
  'in', 'inside', 'into', 'near', 'of', 'off', 'on', 'onto', 'out',
  'outside', 'over', 'through', 'throughout', 'to', 'toward', 'towards',
  'under', 'underneath', 'until', 'up', 'upon', 'with', 'within', 'without',
  'and', 'but', 'or', 'nor', 'yet', 'so', 'because', 'since', 'although',
  'though', 'while', 'whereas', 'unless', 'if', 'whether', 'after',
  'before', 'once', 'than', 'that', 'when', 'where', 'why', 'how',
  'is', 'are', 'was', 'were', 'been', 'being', 'be', 'am',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might',
  'must', 'need', 'dare', 'ought',
  'get', 'got', 'getting', 'make', 'made', 'making', 'take', 'took',
  'taking', 'go', 'went', 'going', 'gone', 'come', 'came', 'coming',
  'see', 'saw', 'seen', 'know', 'knew', 'known', 'think', 'thought',
  'give', 'gave', 'given', 'find', 'found', 'tell', 'told', 'use',
  'used', 'using', 'say', 'said', 'try', 'tried', 'trying', 'ask',
  'asked', 'asking', 'work', 'worked', 'working', 'call', 'called',
  'calling', 'keep', 'kept', 'keeping', 'let', 'start', 'started',
  'show', 'showed', 'shown', 'hear', 'heard', 'play', 'played',
  'run', 'ran', 'running', 'move', 'moved', 'moving', 'live', 'lived',
  'living', 'believe', 'bring', 'brought', 'happen', 'happened',
  'write', 'wrote', 'written', 'provide', 'sit', 'sat', 'stand',
  'stood', 'lose', 'lost', 'pay', 'paid', 'meet', 'met', 'include',
  'continue', 'set', 'learn', 'learned', 'change', 'changed', 'lead',
  'led', 'understand', 'understood', 'watch', 'follow', 'stop', 'stopped',
  'create', 'created', 'speak', 'spoke', 'spoken', 'read', 'allow',
  'add', 'spend', 'spent', 'grow', 'grew', 'grown', 'open', 'opened',
  'walk', 'win', 'won', 'offer', 'remember', 'love', 'consider',
  'appear', 'buy', 'bought', 'wait', 'serve', 'send', 'sent', 'expect',
  'build', 'built', 'stay', 'fall', 'fell', 'fallen', 'cut', 'reach',
  'kill', 'remain', 'suggest', 'raise', 'pass', 'sell', 'sold',
  'require', 'report', 'decide', 'pull', 'develop', 'fix', 'fixed',
  'fixing', 'share', 'shared', 'sharing', 'point', 'pointed', 'pointing',
  'figure', 'transmit', 'transmitted', 'cause', 'caused', 'causing',
  'message', 'spacing', 'happening', 'working', 'meaning', 'feeling',
  'looking', 'trying', 'asking', 'following', 'checking', 'waiting',
  'good', 'better', 'best', 'bad', 'worse', 'worst', 'new', 'old',
  'first', 'last', 'long', 'great', 'little', 'right', 'high', 'low',
  'different', 'small', 'large', 'next', 'early', 'young', 'important',
  'few', 'same', 'able', 'possible', 'sure', 'real', 'simple',
  'clear', 'hard', 'easy', 'nice', 'fine', 'okay', 'ok', 'alright',
  'very', 'too', 'also', 'just', 'only', 'even', 'still', 'already',
  'yet', 'always', 'never', 'often', 'usually', 'sometimes', 'rarely',
  'ever', 'again', 'well', 'really', 'quite', 'pretty', 'almost',
  'nearly', 'soon', 'later', 'then', 'now', 'today', 'once', 'here',
  'there', 'where', 'when', 'why', 'how', 'so', 'much', 'many',
  'actually', 'basically', 'honestly', 'frankly', 'hopefully',
  'probably', 'possibly', 'maybe', 'perhaps', 'absolutely', 'definitely',
  'certainly', 'obviously', 'apparently', 'unfortunately', 'fortunately',
  'especially', 'particularly', 'specifically', 'generally', 'typically',
  'not', "n't", 'no', 'never', 'nothing', 'none', 'nobody', 'nowhere',
  "'s", "'t", "'re", "'ve", "'ll", "'d", "'m",
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'first', 'second', 'third', 'time', 'times', 'day',
  'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'now',
  'today', 'tomorrow', 'yesterday', 'minute', 'minutes', 'hour', 'hours',
  'ago', 'later', 'soon', 'early', 'late',
  'please', 'thanks', 'thank', 'sorry', 'hello', 'hi', 'hey', 'yes',
  'yeah', 'no', 'nope', 'sure', 'okay', 'ok', 'alright', 'right',
  'example', 'issue', 'problem', 'question', 'answer', 'solution',
  'idea', 'way', 'thing', 'things', 'part', 'parts', 'kind', 'sort',
  'type', 'lot', 'lots', 'bit', 'little', 'bit', 'big', 'huge',
  'whole', 'every', 'each', 'either', 'neither', 'whether', 'whatever',
  'maybe', 'perhaps', 'actually', 'thing', 'stuff', 'something',
  'everything', 'nothing', 'anything',
  // Application-specific
  'starguard', 'codenomad', 'tokidapp', 'star', 'card', 'token',
  // Contraction fragments
  "'s", "'t", "'re", "'ve", "'ll", "'d", "'m",
  // Common contractions
  "it's", "that's", "what's", "there's", "here's", "he's", "she's",
  "let's", "how's", "why's", "where's", "when's", "who's",
  "don't", "can't", "won't", "didn't", "doesn't", "isn't", "aren't",
  "wasn't", "weren't", "haven't", "hasn't", "hadn't", "couldn't",
  "shouldn't", "wouldn't", "mustn't", "needn't", "mightn't",
  "i'm", "i've", "i'll", "i'd",
  "you're", "you've", "you'll", "you'd",
  "we're", "we've", "we'll", "we'd",
  "they're", "they've", "they'll", "they'd",
  "he'll", "she'll", "it'll", "there'll",
  "he'd", "she'd", "it'd",
  "gonna", "wanna", "gotta", "kinda", "sorta", "gotcha", "lemme", "dunno",
])

function restoreWordSpacing(text: string): string {
  if (!text || /\s/.test(text)) return text

  // Phase 1: Regex-based boundary fixes for punctuation and casing
  let out = text
    .replace(/([.!?])([A-Za-z])/g, '$1 $2')
    .replace(/([,;])([A-Za-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([)\]}])([A-Za-z])/g, '$1 $2')
    .replace(/([A-Za-z])([\[({])/g, '$1 $2')

  // Phase 2: Greedy dictionary-based word segmentation for remaining
  //          concatenated runs (e.g. "sowecan" → "so we can").
  //          Trailing punctuation is stripped before matching and re-attached
  //          afterward so that e.g. "fixit?" matches "fix" and "it".
  const segments = out.split(/\s+/)
  const result: string[] = []

  for (const seg of segments) {
    if (seg.length <= 3 || COMMON_WORDS.has(seg.toLowerCase())) {
      result.push(seg)
      continue
    }

    // Strip trailing punctuation for dictionary matching
    const trailingPunct = seg.match(/[.!?,'";:)\]}\u2019]+$/)
    const cleanSeg = trailingPunct ? seg.slice(0, -trailingPunct[0].length) : seg
    const suffix = trailingPunct ? trailingPunct[0] : ''

    if (cleanSeg.length <= 3 || COMMON_WORDS.has(cleanSeg.toLowerCase())) {
      result.push(seg)
      continue
    }

    // Greedy longest-prefix match on clean segment
    const words: string[] = []
    let remaining = cleanSeg

    while (remaining.length > 0) {
      let matched = false
      const maxLen = Math.min(20, remaining.length)
      for (let len = maxLen; len >= 2; len--) {
        if (COMMON_WORDS.has(remaining.substring(0, len).toLowerCase())) {
          words.push(remaining.substring(0, len))
          remaining = remaining.substring(len)
          matched = true
          break
        }
      }
      if (!matched) {
        words.push(remaining[0])
        remaining = remaining.substring(1)
      }
    }

    result.push(words.join(' ') + suffix)
  }

  return result.join(' ')
}

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const ETH_ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/g
const LONG_HEX_RE = /\b0x[0-9a-fA-F]{16,}\b/g
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi
const FILE_PATH_RE =
  /(?:^|[\s(])(?:\/?(?:Users|home|var|tmp|src|contracts|CodeNomad)[^\s)\],:;]+|(?:\.\.?\/)+[\w./-]+|[\w.-]+\/(?:[\w.-]+\/)+[\w.-]+)/g

const ENTITY_ALIASES: Record<string, string> = {
  "0xef89dc4e687d5ffa44bf3ed537cb37f1619756c1": "Dynamic Splitter",
  "0xc71829068aaff3c75c1c23a89c741570b51f839c": "Star Bridge",
  "0x87387dd7c75bd129d8898f050924118004dbdcdf": "STARX token (old)",
  "0x3ea0eae1fe4029714e9e3ec834299078445aa391": "STARX token",
  starguard: "StarWORLD",
  codenomad: "CodeNomad",
  tokidapp: "TokiDAPP",
}

export function sanitizeSpeechText(text: string): string {
  if (!text) return text
  let out = text
  for (const [key, label] of Object.entries(ENTITY_ALIASES)) {
    out = out.replace(new RegExp(key, "gi"), label)
  }
  out = out.replace(URL_RE, "the link")
  out = out.replace(ETH_ADDRESS_RE, "the contract")
  out = out.replace(LONG_HEX_RE, "the identifier")
  out = out.replace(UUID_RE, "the record")
  out = out.replace(FILE_PATH_RE, (m) => {
    const trimmed = m.trim()
    const base = trimmed.split("/").pop() || trimmed
    const name = base.replace(/\.(tsx?|jsx?|sol|md|json)$/i, "").replace(/[-_]/g, " ")
    return ` ${name || "the file"} `
  })
  // NOTE: restoreWordSpacing intentionally NOT applied here.
  // sanitizeSpeechText is called on LLM text deltas and tool results,
  // which already have proper spacing. restoreWordSpacing is only for
  // ASR voice transcripts that arrive concatenated (e.g. "Thanksforthis").
  // Voice transcripts go through sanitizeAsrText() instead.

  return out.replace(/\s{2,}/g, " ").trim()
}

/**
 * Sanitize ASR (Automatic Speech Recognition) voice transcripts.
 * Includes word-spacing recovery for concatenated ASR output.
 * Use this instead of sanitizeSpeechText for raw voice transcripts.
 */
export function sanitizeAsrText(text: string): string {
  if (!text) return text
  let out = text
  for (const [key, label] of Object.entries(ENTITY_ALIASES)) {
    out = out.replace(new RegExp(key, "gi"), label)
  }
  out = out.replace(URL_RE, "the link")
  out = out.replace(ETH_ADDRESS_RE, "the contract")
  out = out.replace(LONG_HEX_RE, "the identifier")
  out = out.replace(UUID_RE, "the record")

  // Restore word spacing for concatenated ASR output
  out = restoreWordSpacing(out)

  return out.replace(/\s{2,}/g, " ").trim()
}

/**
 * Voice instructions for GPT Realtime v2 (gpt-realtime-2).
 * Structured prompt following OpenAI's Realtime 2 prompting guide.
 * @see https://developers.openai.com/api/docs/guides/realtime-models-prompting
 */
export const VOICE_INSTRUCTIONS = `# Role and Objective
You are Star World Assistant, the voice assistant for the StarCARD ecosystem. You help developers investigate code, generate features, run tests, manage git, deploy, and orchestrate multi-step workflows.

# Personality and Tone
- Professional but approachable
- Calm and confident under complexity
- Technical precision when discussing code, casual warmth when checking in

# Language
- Use natural spoken English
- Never read aloud file paths, URLs, wallet addresses, UUIDs, or raw hex
- Refer to resources by friendly names: Dynamic Splitter, Star Bridge, StarGuard, CodeNomad, Star World Assistant

# Reasoning
- For direct answers, simple lookups, and short confirmations, respond quickly without reasoning
- For multi-step tasks, tool decisions, troubleshooting, or escalation, reason before acting
- Do not perform extended reasoning when the user's audio is unclear; ask for clarification instead

# Preambles
Use short preambles only when they help the user understand that work is happening.

When to use a preamble:
- About to call a tool that may take noticeable time
- Preparing a multi-step response
- Checking records or system state
- Silence would make you feel unresponsive

When to NOT use a preamble:
- Answer is direct and immediate
- User is confirming, correcting, or declining
- Audio is unclear and you need clarification
- Tool call is lightweight

Preamble style: One short natural sentence. Vary wording. Describe the action, not internal reasoning.
Examples: "I'll check that now." / "Let me look that up." / "Running the tests."

# Verbosity
- Direct answers: 1-2 short sentences
- Clarifying questions: One question at a time
- Tool results: Summarize first, then give next useful action
- Troubleshooting: One step at a time unless asked for full procedure
- When a multi-step task finishes, briefly offer to continue or give a one-sentence overview

# Tools
Use only the tools explicitly provided. Do not invent, assume, or simulate tools.

For read-only tools:
- Call when user's intent is clear and required fields are available
- Ask clarification only if required field is missing or ambiguous

For write tools or external actions:
- Summarize the intended action before calling
- Ask for confirmation before calling
- Only say action was completed after tool call succeeds
- If tool fails, explain briefly and give clear next step

For exact identifiers (commit hashes, task IDs, etc.):
- Confirm the value before using in a tool call
- If user corrects, repeat the full corrected value

# Unclear Audio
- Only respond to clear audio or text
- If audio is unclear, ask: "Sorry, could you repeat that clearly?"
- Do not guess what the user meant
- Do not call tools or provide preambles when audio is unclear
- Do not repeat the same clarification twice

# Entity Capture
- When user spells out IDs or codes character by character, treat as compact value
- Preserve explicitly spoken separators (dash, dot, underscore)
- Do not insert spaces between spelled-out characters
- For numeric IDs, convert spoken numbers to digits
- Read back high-precision values digit by digit before tool calls

# Handling Silence and Background Noise
If audio is silence, background noise, or speech not addressed to you, stay quiet and listen.
Resume normal responses only when the user clearly addresses you or asks for help.

# Knowledge Base
When the user asks about architecture entities (contracts, chains, venues, tokens, actors):
- Use the \`query_knowledge_base\` tool to search the StarCARD architecture knowledge base
- Read back the entity name, stableId, domain, and description in natural spoken language
- Use friendly names for entities: \u201cRevenuePool\u201d instead of \u201cSC.contract.RevenuePool\u201d
- After reading entity info, ask if they want to see relations or diagrams

When the user mentions a Sepolia contract address:
- Use the \`get_sepolia_deployments\` tool to retrieve known deployment addresses
- Read back the contract name and address in natural language
- Do NOT read the full address aloud — say "the address is in the message below"

# Wiki Knowledge Base
You have direct access to the StarCARD architecture wiki — markdown entity pages with cross-references.

When answering architecture questions:
- Use read_wiki_page to load the relevant entity page(s)
- Follow wikilinks to related entities for full context
- Synthesize information across multiple pages when relevant
- Use friendly names: "RevenuePool" not "SC.contract.RevenuePool"

When the user shares new information or corrections about an entity:
- Identify which wiki page(s) are affected
- Use write_to_wiki to update the relevant section
- Confirm what was updated

When you find contradictions between wiki and user input:
- Flag the discrepancy to the user
- Ask which version is correct
- Update the wiki accordingly

# Confidence Protocol
When answering from wiki or knowledge base tools, rate your confidence internally before responding:

- **high**: Direct entity page found, wikilinks confirm relationships, no contradictions
- **medium**: Partial match, some synthesis required, or data may be stale (lint_wiki shows stale pages)
- **low**: No direct match, answer based on inference from related pages

Apply these rules based on your confidence level:
- If **low**: Say "I'm not fully certain — let me look that up" and call search_wiki for a broader search before answering
- If **medium**: Add a brief qualifier like "Based on what I know..." or "From what I can see in the wiki..."
- If **high**: Answer directly without hedging

Never guess or fabricate entity information. If you cannot find a relevant page after searching, say so honestly.

# Source Tracking
When answering questions about architecture entities:
- Note which wiki page(s) you drew from in your reasoning
- If the user asks "where did that come from?", reference the specific page name
- When the lint_wiki tool reports issues (orphan pages, broken links), mention specific examples to help the user understand wiki health

When updating a wiki page via write_to_wiki:
- Add a comment at the end of the updated section: <!-- Last updated: YYYY-MM-DD | Source: voice conversation -->
- When creating a new page, include frontmatter with created date and source field
- Confirm to the user which page was updated and what changed

# Vision and File Understanding
When the user uploads or attaches an image (screenshot, diagram, photo, document scan, logo, chart):
- The system will automatically analyze the image and inject the vision results into context
- You can also proactively use the \`vision_analyze\` tool on any image URL in the conversation to get even more detail
- When a document (PDF, spreadsheet, code file) is attached, its extracted text is already included in the context

# Diagrams
When the user asks you to create or explain a diagram, chart, flowchart, architecture diagram, or any visual structure:
- Use the \`generate_diagram\` tool to create Mermaid diagram source code
- The diagram will be displayed visually in the chat
- You can describe what the diagram shows after generating it
- If the user wants modifications, describe the changes and regenerate`
