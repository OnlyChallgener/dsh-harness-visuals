/**
 * The session header's agent-preset label.
 *
 * The label names what this session runs and doubles as a switch: picking
 * another preset recomposes the live agent, and the change applies from the
 * next turn on. The host logs the switch, so a resumed session rebuilds the
 * preset it last ran.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutline16, IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentPresetSettingsState } from './settings-store.ts'
import { presetDisplayText } from './locales.ts'
import css from './AgentPresetLabel.module.css'

/** Registration-side business face for the header label. */
export interface AgentPresetLabelInjected {
  hooks: {
    /** Roster snapshot bound by the renderer as useAgentPresets. */
    agentPresets: SnapshotStore<AgentPresetSettingsState>
  }
  /** Read the roster, so the label can show a name rather than an id. */
  load: () => Promise<void>
  /** Recompose this session from another preset. */
  select: (sessionId: string, id: string) => Promise<void>
}

/** Full component props. */
export type AgentPresetLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetLabelInjected>

/**
 * Render this session's agent-preset name beside its title, switchable through
 * the roster menu.
 * @param props - composed slot props.
 * @returns the label, or null when the session records no preset.
 */
export function AgentPresetLabel({
  sessionId, useSessions, useAgentPresets, load, select, t,
}: AgentPresetLabelProps) {
  const preset = useSessions(state => state.byId[sessionId]?.agentPreset)
  const options = useAgentPresets(state => state.options)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Deployments that compose no presets never label anything, so the roster
    // is only worth a request once a session reports one.
    if (preset !== undefined) void load()
  }, [preset, load])

  if (preset === undefined) return null

  const option = options.find(entry => entry.id === preset)
  const text = option === undefined ? undefined : presetDisplayText(option, t)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={options.map((entry) => {
        const entryText = presetDisplayText(entry, t)
        return {
          id: entry.id,
          label: (
            <span className={css.item}>
              <span className={css.itemName}>{entryText.name}</span>
              {entryText.description !== undefined && (
                <span className={css.itemDesc}>{entryText.description}</span>
              )}
            </span>
          ),
        }
      })}
      selectedId={preset}
      onSelect={(id) => {
        setOpen(false)
        if (id === preset || busy) return
        setBusy(true)
        void select(sessionId, id).finally(() => { setBusy(false) })
      }}
      align="start"
      portal
      anchor={(
        <button
          type="button"
          className={css.label}
          aria-haspopup="menu"
          aria-expanded={open}
          title={text?.description ?? t('headerHint')}
          disabled={busy}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconAgentPresetOutline16 size={14} className={css.icon} />
          {text?.name ?? preset}
          <IconChevronDownOutline14 className={css.chevron} />
        </button>
      )}
    />
  )
}
