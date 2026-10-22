import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { pushToast, setBuildProject, setScope, setState } from '../store.ts';
import { Modal } from '../ui.tsx';
import type { DirListing } from '../../../shared/types.ts';

// Pick a folder to build in: Finder dialog on this Mac, or browse folders right here.
export function FolderPicker({ returnTo }: { returnTo: 'settings' | 'chat' | 'sidebar' }) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [finderBusy, setFinderBusy] = useState(false);

  const go = async (path: string) => {
    try {
      const l = await api.listDirs(path);
      setListing(l);
      setPathInput(l.path);
    } catch {
      /* toast already shown */
    }
  };
  useEffect(() => {
    void go('~/Desktop');
  }, []);

  const close = () => setState({ modal: returnTo === 'settings' ? 'settings' : null });

  const use = async (path: string) => {
    const project = await api.addProject(path);
    setBuildProject(project.id);
    if (returnTo === 'sidebar') setScope(String(project.id)); // open the new project's master
    pushToast(`Building in ${project.name}${project.isGit ? '' : ' (not a git repo: agents work in place, one at a time)'}`);
    close();
  };

  const finder = async () => {
    setFinderBusy(true);
    try {
      const { path } = await api.chooseFolder();
      if (path) await use(path);
    } finally {
      setFinderBusy(false);
    }
  };

  return (
    <Modal onClose={close}>
      <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
        <h2 className="text-[17px] font-semibold">Choose a folder to build in</h2>
        <button className="btn-line" onClick={finder} disabled={finderBusy}>
          {finderBusy ? 'Waiting for Finder…' : 'Open in Finder'}
        </button>
      </div>

      <form
        className="flex gap-2 px-5"
        onSubmit={(e) => {
          e.preventDefault();
          void go(pathInput);
        }}
      >
        <input className="field font-mono text-[12.5px]" value={pathInput} onChange={(e) => setPathInput(e.target.value)} aria-label="Folder path" />
        <button className="btn-ghost">Go</button>
      </form>

      <ul className="mx-5 mt-3 max-h-[46vh] overflow-y-auto rounded-[12px] bg-base">
        {listing?.parent && (
          <li>
            <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted hover:bg-raised" onClick={() => go(listing.parent!)}>
              ↑ Up to {listing.parent.split('/').pop() || '/'}
            </button>
          </li>
        )}
        {listing?.dirs.map((d) => (
          <li key={d.path} className="group flex items-center border-t border-line/70 first:border-t-0">
            <button className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-raised" onClick={() => go(d.path)}>
              <span className="truncate">{d.name}</span>
              {d.isGit && <span className="chip text-done">git</span>}
            </button>
            <button className="btn-ghost mr-1.5 opacity-0 focus:opacity-100 group-hover:opacity-100" onClick={() => use(d.path)}>
              Use
            </button>
          </li>
        ))}
        {listing && listing.dirs.length === 0 && <li className="px-3 py-2 text-[12.5px] text-faint">No folders inside.</li>}
      </ul>

      <div className="flex items-center justify-between gap-2 px-5 py-4">
        <p className="min-w-0 truncate text-[12.5px] text-muted">
          {listing ? (
            <>
              Current: <span className="font-mono text-ink">{listing.path.split('/').pop()}</span>
              {listing.isGit ? ' (git repo)' : ' (not a git repo)'}
            </>
          ) : (
            'Loading…'
          )}
        </p>
        <div className="flex shrink-0 gap-2">
          <button className="btn-ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn-run" disabled={!listing} onClick={() => listing && use(listing.path)}>
            Build in this folder
          </button>
        </div>
      </div>
    </Modal>
  );
}
