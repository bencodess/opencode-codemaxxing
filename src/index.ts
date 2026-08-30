import type { Plugin } from "@opencode-ai/plugin"
import type { Message, Model } from "@opencode-ai/sdk"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface CodeMaxxingOptions {
  enabled?: boolean
  maxTokens?: number
  maxRounds?: number
  focus?: string
  keepGoingWhenStable?: boolean
  delayMs?: number
  skipOnError?: boolean
  paths?: string[]
  promptTemplate?: string
  stateFile?: string
  // If true, codemaxxing backs off once the session has eaten most of the
  // model's context window, so it never starves your real conversation.
  respectModelLimit?: boolean
  // How much of the context window to leave untouched when respectModelLimit
  // is on. 0.2 = keep the last 20% of the window free.
  contextHeadroom?: number
}

const defaults = {
  enabled: true,
  maxTokens: 500_000,
  maxRounds: 25,
  focus: "correctness, quality, performance",
  keepGoingWhenStable: true,
  delayMs: 2500,
  skipOnError: true,
  paths: [] as string[],
  promptTemplate: "",
  stateFile: ".codemaxxing.json",
  respectModelLimit: true,
  contextHeadroom: 0.2,
}

type RoundState = { round: number; lastChurn: number; lastContext: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isAssistant(info: Message): info is Extract<Message, { role: "assistant" }> {
  return info.role === "assistant" && "tokens" in info
}

export const CodeMaxxing: Plugin = async (ctx, options) => {
  const opts = { ...defaults, ...(options ?? {}) }
  const { client, project, worktree, directory } = ctx
  const root = worktree ?? directory

  // Per-session round tracking. We deliberately don't persist this; only the
  // token budget carries over between restarts.
  const rounds = new Map<string, RoundState>()
  let carriedTokens = 0
  let stateLoaded = false
  let trackedLimit = 0

  const stateFile = opts.stateFile
    ? opts.stateFile.startsWith("/")
      ? opts.stateFile
      : `${root}/${opts.stateFile}`
    : null

  async function loadState() {
    if (stateLoaded) return
    stateLoaded = true
    if (!stateFile) return
    try {
      const raw = await readFile(stateFile, "utf8")
      const data = JSON.parse(raw)
      if (typeof data.tokensUsed === "number") carriedTokens = data.tokensUsed
    } catch {
      carriedTokens = 0
    }
  }

  async function saveState(tokens: number) {
    if (!stateFile) return
    try {
      await mkdir(dirname(stateFile), { recursive: true })
      await writeFile(stateFile, JSON.stringify({ tokensUsed: tokens, updated: Date.now() }), "utf8")
    } catch {
      // best effort; nothing to gain from throwing
    }
  }

  async function tokensUsed(sessionID: string): Promise<number> {
    try {
      const res = await client.session.messages({ path: { id: sessionID } })
      const msgs = Array.isArray(res) ? res : res?.data
      if (!Array.isArray(msgs)) return carriedTokens
      let sum = 0
      for (const m of msgs) if (isAssistant(m.info)) sum += m.info.tokens.input + m.info.tokens.output
      return sum + carriedTokens
    } catch {
      return carriedTokens
    }
  }

  async function changedFiles(): Promise<number> {
    try {
      const res = await (client as any).file.status()
      const files = Array.isArray(res) ? res : res?.data
      if (!Array.isArray(files)) return 0
      return files.filter((f: any) => f?.status && f.status !== "?" && f.status !== " ").length
    } catch {
      return 0
    }
  }

  function buildPrompt(round: number, focus: string, churn: number, template: string): string {
    if (template && template.trim()) {
      return template.replaceAll("{{ROUND}}", String(round)).replaceAll("{{FOCUS}}", focus)
    }

    const churnHint =
      churn > 0
        ? `Last round touched ${churn} file(s). Keep going: verify it, catch any regressions, and move on to the next thing.`
        : `Last round didn't change anything. Stop hand-waving and land one small, real improvement now.`

    const scope =
      opts.paths.length > 0 ? `\nOnly touch these paths: ${opts.paths.join(", ")}` : ""

    return `[codemaxxing round ${round}]

Keep improving this project. Don't stop at "done" — pick the next highest-value fix and implement it.

Focus: ${focus || "quality, correctness, performance"}.

${churnHint}

Do this:
1. Look at the current state (read files, spot TODOs, dead code, type errors, missing tests, duplication, recent edits).
2. Choose ONE small, concrete improvement that fits the focus.
3. Make it with real edits. Prefer a quick verified win over a big rewrite.
4. Run a check if you can (tests, typecheck, lint).
5. Say in a couple of lines what you changed and why.

Rules:
- You are doing the work, not recommending it.
- Don't break things or wander into unrelated files.
- If it's genuinely already good and there's nothing actionable, reply "STABLE" and stop — don't invent busywork.${scope}`
  }

  async function runRound(sessionID: string): Promise<boolean> {
    const st = rounds.get(sessionID) ?? { round: 0, lastChurn: 0, lastContext: 0 }
    st.round += 1
    rounds.set(sessionID, st)

    const used = await tokensUsed(sessionID)

    // Hard budget from config.
    if (used >= opts.maxTokens) {
      await log(`codemaxxing: hit budget (${used}/${opts.maxTokens}), stopping`)
      await saveState(used)
      return false
    }

    // Respect the model's own context window if requested, leaving headroom.
    if (opts.respectModelLimit && trackedLimit > 0) {
      const allowed = Math.floor(trackedLimit * (1 - opts.contextHeadroom))
      if (used >= allowed) {
        await log(`codemaxxing: near model context limit (${used}/${trackedLimit}), backing off`)
        return false
      }
    }

    if (st.round > opts.maxRounds) {
      await log(`codemaxxing: hit round cap (${opts.maxRounds}), stopping`)
      return false
    }

    const prompt = buildPrompt(st.round, opts.focus, st.lastChurn, opts.promptTemplate)
    await log(`codemaxxing: round ${st.round} (${used} tokens so far)`)
    await sleep(opts.delayMs)

    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: { agent: "build", parts: [{ type: "text", text: prompt }] },
      })
    } catch (e) {
      await log(`codemaxxing: prompt failed: ${(e as Error)?.message ?? e}`)
      return false
    }

    st.lastChurn = await changedFiles()
    return true
  }

  async function log(message: string) {
    try {
      await client.app.log({ body: { service: "codemaxxing", level: "info", message } })
    } catch {
      // ignore
    }
  }

  return {
    // Watch the model actually being used in this session so we can honor its
    // context limit. This is the only place opencode hands us the model object.
    "chat.params": async ({ model }, _output) => {
      trackedLimit = model?.limit?.context ?? 0
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (!opts.enabled) return

      // Only drive sessions that belong to this project.
      if (project?.id) {
        try {
          const s = await client.session.get({ path: { id: sessionID } })
          const info = s.data
          if (info && info.projectID && info.projectID !== project.id) return
        } catch {
          return
        }
      }

      await loadState()

      if (opts.skipOnError) {
        try {
          const res = await client.session.messages({ path: { id: sessionID } })
          const msgs = Array.isArray(res) ? res : res?.data
          const last = msgs?.at(-1)
          if (last?.info && isAssistant(last.info) && last.info.error) {
            await log("codemaxxing: last run errored, skipping round")
            return
          }
        } catch {
          return
        }
      }

      const churn = await changedFiles()
      const st = rounds.get(sessionID)
      if (st && st.lastChurn === 0 && churn === 0 && !opts.keepGoingWhenStable) {
        await log("codemaxxing: stable and told to stop on stable, doing that")
        return
      }

      runRound(sessionID).catch((e) => log(`codemaxxing error: ${(e as Error)?.message ?? e}`))
    },
  }
}

export default CodeMaxxing
