import { TextAttributes, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useDialog } from "../../ui/dialog"
import { useTheme } from "@tui/context/theme"
import type { Part, AssistantMessage } from "@opencode-ai/sdk/v2"
import { useSync } from "@tui/context/sync"
import { Clipboard } from "../../util/clipboard"
import { useToast } from "../../ui/toast"
import { createSignal, For, Show } from "solid-js"
import { Token } from "@/util/token"

interface DialogInspectProps {
  message: AssistantMessage | any
  parts: Part[]
}

const PartCard = (props: { title: string; children: any; theme: any }) => (
  <box flexDirection="column" borderColor={props.theme.borderSubtle} borderStyle="single" padding={1}>
    <text attributes={TextAttributes.BOLD} fg={props.theme.textMuted}>
      {props.title}
    </text>
    {props.children}
  </box>
)

export function DialogInspect(props: DialogInspectProps) {
  const sync = useSync()
  const { theme, syntax } = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const msg = () => sync.data.message[props.message.sessionID]?.find((m) => m.id === props.message.id)
  const parts = () => sync.data.part[props.message.id] ?? props.parts

  const [showRaw, setShowRaw] = createSignal(true)
  dialog.setSize("xlarge")

  let scrollRef: ScrollBoxRenderable | undefined

  const copy = () =>
    Clipboard.copy(JSON.stringify(props.parts, null, 2))
      .then(() => toast.show({ message: "Copied", variant: "success" }))
      .catch(() => toast.show({ message: "Failed", variant: "error" }))

  const toggleRaw = () => setShowRaw((p) => !p)

  useKeyboard((evt) => {
    const h = {
      down: () => scrollRef?.scrollBy(1),
      up: () => scrollRef?.scrollBy(-1),
      pagedown: () => scrollRef?.scrollBy(scrollRef?.height ?? 20),
      pageup: () => scrollRef?.scrollBy(-(scrollRef?.height ?? 20)),
    }
    const k: Record<string, () => void> = {
      c: copy,
      s: toggleRaw,
      down: h.down,
      up: h.up,
      pagedown: h.pagedown,
      pageup: h.pageup,
    }
    if (k[evt.name]) {
      evt.preventDefault()
      k[evt.name]()
    }
  })

  const toolEstimate = () => {
    const p = parts()
    let sum = 0
    for (const part of p) {
      if (part.type === "tool") {
        const state = (part as any).state
        if (state?.output) {
          const output = typeof state.output === "string" ? state.output : JSON.stringify(state.output)
          sum += Token.estimate(output)
        }
      }
    }
    return sum
  }

  const tokenFields =
    msg()?.role === "assistant"
      ? {
          line1: [
            { l: "Input", v: (msg() as any).tokens?.input },
            { l: "Output", v: (msg() as any).tokens?.output },
            { l: "Reasoning", v: (msg() as any).tokens?.reasoning },
            { l: "Tool", v: toolEstimate(), estimated: true },
          ],
          line2: [
            { l: "Cache Write", v: (msg() as any).tokens?.cache?.write },
            { l: "Cache Read", v: (msg() as any).tokens?.cache?.read },
          ],
        }
      : null

  const tokenTotal = tokenFields
    ? [...tokenFields.line1.filter((f) => !f.estimated), ...tokenFields.line2].reduce((s, f) => s + (f.v || 0), 0)
    : 0

  const renderPart = (part: Part) => {
    if (part.type === "text")
      return (
        <PartCard title="Text" theme={theme}>
          <text fg={theme.text}>{part.text}</text>
        </PartCard>
      )
    if (part.type === "patch")
      return (
        <PartCard title={`Patch (${part.hash?.substring(0, 7)})`} theme={theme}>
          <text fg={theme.text}>Updated: {part.files?.join(", ")}</text>
        </PartCard>
      )
    if (part.type === "tool")
      return (
        <PartCard title={`Tool: ${part.tool} (${part.state?.status})`} theme={theme}>
          <text fg={theme.textMuted}>Input: {JSON.stringify(part.state?.input)}</text>
          <Show when={part.state?.status === "completed" && (part.state as any).output}>
            <text fg={theme.text}>{JSON.stringify((part.state as any).output)}</text>
          </Show>
          <Show when={part.state?.status === "error" && (part.state as any).error}>
            <text fg={theme.error}>{(part.state as any).error}</text>
          </Show>
        </PartCard>
      )
    if (part.type === "file")
      return (
        <PartCard title="File" theme={theme}>
          <text fg={theme.text}>
            {part.filename} ({part.mime})
          </text>
        </PartCard>
      )
    return (
      <PartCard title={part.type} theme={theme}>
        <code
          filetype="json"
          content={JSON.stringify(part, null, 2)}
          syntaxStyle={syntax()}
          drawUnstyledText
          fg={theme.text}
        />
      </PartCard>
    )
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} height="100%">
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Inspection ({props.message.id})
        </text>
        <box onMouseUp={() => dialog.clear()}>
          <text fg={theme.textMuted}>[esc]</text>
        </box>
      </box>

      <Show when={tokenFields}>
        <box borderStyle="single" borderColor={theme.borderSubtle} padding={1} flexShrink={0}>
          <box flexDirection="row" gap={2} flexWrap="wrap">
            <For each={tokenFields!.line1}>
              {(f) => (
                <text fg={theme.textMuted}>
                  {f.l}:{" "}
                  <span style={{ fg: theme.text }}>
                    {f.estimated && f.v ? "~" : ""}
                    {(f.v || 0).toLocaleString()}
                  </span>
                </text>
              )}
            </For>
          </box>
          <box flexDirection="row" gap={2} flexWrap="wrap">
            <For each={tokenFields!.line2}>
              {(f) => (
                <text fg={theme.textMuted}>
                  {f.l}: <span style={{ fg: theme.text }}>{(f.v || 0).toLocaleString()}</span>
                </text>
              )}
            </For>
          </box>
          <text fg={theme.accent} marginTop={1}>
            Total: {tokenTotal.toLocaleString()} tokens
          </text>
        </box>
      </Show>

      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        flexGrow={1}
        border={["bottom", "top"]}
        borderColor={theme.borderSubtle}
      >
        <Show
          when={!showRaw()}
          fallback={
            <code
              filetype="json"
              content={JSON.stringify(parts(), null, 2)}
              syntaxStyle={syntax()}
              drawUnstyledText
              fg={theme.text}
            />
          }
        >
          <box flexDirection="column" gap={1}>
            <For each={parts().filter((p) => !["step-start", "step-finish", "reasoning"].includes(p.type))}>
              {(p) => renderPart(p)}
            </For>
          </box>
        </Show>
      </scrollbox>

      <box flexDirection="row" justifyContent="space-between" paddingBottom={1} flexShrink={0} gap={1}>
        <box flexDirection="row" gap={2}>
          <text fg={theme.textMuted}>↑↓ PgUp/Dn</text>
          <text fg={theme.textMuted}>S raw</text>
          <text fg={theme.textMuted}>C copy</text>
        </box>
        <box flexDirection="row" gap={1}>
          <box
            paddingLeft={2}
            paddingRight={2}
            borderStyle="single"
            borderColor={theme.borderSubtle}
            onMouseUp={toggleRaw}
          >
            <text fg={theme.text}>{showRaw() ? "Parsed" : "Raw"}</text>
          </box>
          <box paddingLeft={2} paddingRight={2} borderStyle="single" borderColor={theme.border} onMouseUp={copy}>
            <text fg={theme.text}>Copy</text>
          </box>
        </box>
      </box>
    </box>
  )
}
