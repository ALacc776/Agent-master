import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { AgentCommand } from '../../../shared/types.ts';

// "/" autocomplete for a text box. Shows matching commands while the text is a bare "/word".
export function useCommandMenu(text: string, setText: (t: string) => void, commands: AgentCommand[], prefix = '/') {
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const query = text.startsWith(prefix) && !/\s/.test(text) ? text.slice(prefix.length) : undefined;
  const items = useMemo(() => {
    if (query === undefined) return [];
    const q = query.toLowerCase();
    return commands
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
      .slice(0, 8);
  }, [query, commands]);
  useEffect(() => {
    setActive(0);
    if (query === undefined) setDismissed(false);
  }, [query]);
  const open = items.length > 0 && !dismissed;

  const select = (c: AgentCommand) => setText(`${prefix}${c.name} `);

  // Returns true when the key was handled by the menu.
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && items[active] && `${prefix}${items[active].name}` !== text.trim())) {
      e.preventDefault();
      select(items[active]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
      return true;
    }
    return false;
  };

  return { open, items, active, setActive, select, onKeyDown, prefix };
}

export function CommandMenu({ menu, className = '' }: { menu: ReturnType<typeof useCommandMenu>; className?: string }) {
  if (!menu.open) return null;
  return (
    <ul role="listbox" className={`glass absolute inset-x-0 bottom-full z-30 mb-2 max-h-72 overflow-y-auto rounded-[14px] p-1 shadow-bar ${className}`}>
      {menu.items.map((c, i) => (
        <li key={c.name} role="option" aria-selected={i === menu.active}>
          <button
            type="button"
            onMouseEnter={() => menu.setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              menu.select(c);
            }}
            className={`flex w-full items-baseline gap-2 rounded-[10px] px-3 py-1.5 text-left ${i === menu.active ? 'bg-raised' : ''}`}
          >
            <span className="shrink-0 font-mono text-[12.5px] font-medium text-ink">
              {menu.prefix}
              {c.name}
            </span>
            {c.argumentHint && <span className="shrink-0 font-mono text-[11.5px] text-faint">{c.argumentHint}</span>}
            <span className="min-w-0 truncate text-[12.5px] text-muted">{c.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
