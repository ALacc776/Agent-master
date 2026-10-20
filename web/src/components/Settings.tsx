import { useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { pushToast, setState, useStore } from '../store.ts';
import { Modal, modelLabel } from '../ui.tsx';
import { ACCENTS, setTheme, useTheme, type Appearance } from '../theme.ts';
import { Segmented } from './TopBar.tsx';
import { MODELS, type Settings } from '../../../shared/types.ts';

const close = () => setState({ modal: null });

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[24px] w-[40px] shrink-0 rounded-full transition-colors duration-200 ${checked ? 'bg-done' : 'bg-raised'}`}
    >
      <span className={`absolute top-[2px] h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-[left] duration-200 ${checked ? 'left-[18px]' : 'left-[2px]'}`} />
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-4 px-4 py-2">
      <div className="min-w-0">
        <div className="text-[13.5px]">{label}</div>
        {hint && <div className="text-[12px] text-faint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Group({ title, footer, children }: { title: string; footer?: string; children: ReactNode }) {
  return (
    <section className="px-5 pb-5">
      <h3 className="mb-1.5 px-4 text-[13px] font-semibold text-muted">{title}</h3>
      <div className="divide-y divide-line/70 overflow-hidden rounded-[12px] bg-base">{children}</div>
      {footer && <p className="mt-1.5 px-4 text-[12px] text-faint">{footer}</p>}
    </section>
  );
}

export function SettingsModal() {
  const s = useStore((st) => st.settings);
  const projects = useStore((st) => st.projects);
  const rules = useStore((st) => st.rules);
  const prefs = useStore((st) => st.preferences);
  const theme = useTheme();
  const [pref, setPref] = useState('');

  const save = async (patch: Partial<Settings>) => {
    const r = await api.settings(patch);
    if (r.restartNeeded) pushToast('Restart the server to apply the network access change');
  };
  const toggle = (k: keyof Settings, label: string) => <Switch checked={!!s[k]} onChange={(v) => save({ [k]: v })} label={label} />;
  const model = (k: 'masterModel' | 'workerModel' | 'reviewerModel' | 'cheapModel') => (
    <select className="field w-32 py-1" value={s[k]} onChange={(e) => save({ [k]: e.target.value })}>
      {Object.values(MODELS).map((m) => (
        <option key={m} value={m}>
          {modelLabel(m)}
        </option>
      ))}
    </select>
  );
  const num = (k: 'maxConcurrent' | 'dailyCapUsd' | 'stallMinutes' | 'turnWarning', step = 1, max?: number) => (
    <input
      type="number"
      min={k === 'maxConcurrent' ? 1 : 0}
      max={max}
      step={step}
      className="field w-20 py-1 text-right tabular-nums"
      defaultValue={s[k]}
      onBlur={(e) => save({ [k]: max ? Math.min(max, Number(e.target.value)) : Number(e.target.value) })}
    />
  );

  return (
    <Modal onClose={close}>
      <div className="flex items-center justify-between px-5 pb-3 pt-4">
        <h2 className="text-[17px] font-semibold">Settings</h2>
        <button className="btn-line" onClick={close}>
          Done
        </button>
      </div>

      <Group title="Appearance" footer="Saved in this browser.">
        <Row label="Theme">
          <Segmented<Appearance>
            label="Theme"
            value={theme.appearance}
            onChange={(appearance) => setTheme({ appearance })}
            options={[
              { id: 'system', label: 'Auto' },
              { id: 'light', label: 'Light' },
              { id: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Row label="Accent color" hint={ACCENTS.find((a) => a.id === theme.accent)?.label}>
          <div className="flex gap-2" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                role="radio"
                aria-checked={theme.accent === a.id}
                aria-label={a.label}
                title={a.label}
                onClick={() => setTheme({ accent: a.id })}
                className={`h-[18px] w-[18px] rounded-full ring-offset-2 ring-offset-base ${theme.accent === a.id ? 'ring-2 ring-faint' : ''}`}
                style={{ background: a.swatch }}
              />
            ))}
          </div>
        </Row>
      </Group>

      <Group title="Projects">
        {projects.map((p) => (
          <div key={p.id} className="flex min-h-[44px] items-center gap-2 px-4 py-2 text-[13px]">
            <span className="font-medium">{p.name}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-faint">{p.path}</span>
            {!p.isGit && <span className="chip">no git</span>}
            <button className="btn-danger px-2" onClick={() => api.removeProject(p.id)}>
              Remove
            </button>
          </div>
        ))}
        <div className="px-4 py-2">
          <button className="text-[13.5px] font-medium text-run hover:opacity-75" onClick={() => setState({ modal: { folder: 'settings' } })}>
            Add a folder…
          </button>
        </div>
      </Group>

      <Group title="Models" footer="The master picks Haiku, Sonnet or Opus for each task; this is the fallback.">
        <Row label="Master" hint="Cheap and fast keeps the chat snappy">
          {model('masterModel')}
        </Row>
        <Row label="Default for agents">{model('workerModel')}</Row>
        <Row label="Reviewer">{model('reviewerModel')}</Row>
        <Row label="Summaries and suggestions">{model('cheapModel')}</Row>
      </Group>

      <Group title="Limits">
        <Row label="Agents at once" hint="Up to 20">
          {num('maxConcurrent', 1, 20)}
        </Row>
        <Row label="Daily spending cap" hint="In dollars. 0 means no cap">
          {num('dailyCapUsd', 1)}
        </Row>
        <Row label="Flag as stuck after" hint="Minutes without activity">
          {num('stallMinutes')}
        </Row>
        <Row label="Suggest a fresh session after" hint="Turns in one session. 0 turns it off">
          {num('turnWarning', 10)}
        </Row>
      </Group>

      <Group title="Agents can, without asking" footer="Push, merge, deploy, publish, rm -rf and edits outside the worktree always ask you.">
        <Row label="Edit files in their own copy">{toggle('autoAllowEdits', 'Edit files without asking')}</Row>
        <Row label="Run safe commands" hint="Tests, builds, git status and commit, local installs">
          {toggle('autoAllowSafeBash', 'Run safe commands without asking')}
        </Row>
        <Row label="Get an automatic review" hint="A cheap model reads each finished diff">
          {toggle('reviewerEnabled', 'Automatic review')}
        </Row>
      </Group>

      <Group title="Remembered answers">
        {rules.length === 0 && <p className="px-4 py-3 text-[12.5px] text-faint">Tick “Remember this answer” on a card and you won't be asked again.</p>}
        {rules.map((r) => (
          <div key={r.id} className="flex min-h-[44px] items-center gap-2 px-4 py-2 text-[12.5px]">
            <span className={`chip ${r.decision === 'allow' ? 'text-done' : r.decision === 'deny' ? 'text-danger' : ''}`}>{r.decision ?? 'answer'}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
              {r.tool ? `${r.tool}: ` : ''}
              {r.pattern}
              {r.answer ? ` → ${r.answer}` : ''}
            </span>
            <button className="btn-danger px-2" onClick={() => api.removeRule(r.id)}>
              Forget
            </button>
          </div>
        ))}
      </Group>

      <Group title="Preferences" footer="Included in every agent's brief. The master adds to this when you state a preference.">
        {prefs.map((p) => (
          <div key={p.id} className="flex min-h-[44px] items-center gap-2 px-4 py-2 text-[13px]">
            <span className="flex-1">{p.text}</span>
            <button className="btn-danger px-2" onClick={() => api.removePreference(p.id)}>
              Remove
            </button>
          </div>
        ))}
        <form
          className="flex gap-2 px-3 py-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!pref.trim()) return;
            await api.addPreference(pref.trim());
            setPref('');
          }}
        >
          <input className="field bg-transparent" placeholder="Add a preference, like “Always use pnpm”" value={pref} onChange={(e) => setPref(e.target.value)} />
        </form>
      </Group>

      <Group title="Notifications and phone">
        <Row label="Mac notifications">{toggle('macNotifications', 'Mac notifications')}</Row>
        <Row label="Phone push via ntfy.sh" hint="Subscribe to the same topic in the ntfy app. Empty turns it off">
          <input className="field w-40 py-1" placeholder="my-secret-topic" defaultValue={s.ntfyTopic} onBlur={(e) => save({ ntfyTopic: e.target.value.trim() })} />
        </Row>
        <Row label="Open from other devices" hint="Listens on your network after a restart">
          {toggle('lanAccess', 'Open from other devices')}
        </Row>
        {s.lanAccess && (
          <p className="px-4 py-2.5 text-[12px] text-muted">
            Open <span className="font-mono text-ink">http://&lt;this-mac's-ip&gt;:4545/?token={s.accessToken}</span>
          </p>
        )}
      </Group>
    </Modal>
  );
}
