import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

// A styled replacement for <select>. The native option list is drawn by the
// browser and ignores most CSS, so it never matches the page (worst in dark mode).
// The list is position:fixed so it isn't clipped by the scrolling table.
export default function Select({ value, onChange, options, ariaLabel, disabled }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  function openList() {
    if (disabled) return;
    setActive(selectedIndex);
    setOpen(true);
  }

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function choose(index) {
    const option = options[index];
    close();
    if (option && option.value !== value) onChange(option.value);
  }

  // Place the list under the button, or above it if there's no room below.
  useLayoutEffect(() => {
    if (!open) return;
    const r = buttonRef.current.getBoundingClientRect();
    const listHeight = listRef.current?.offsetHeight || 0;
    const below = window.innerHeight - r.bottom;
    const top = below < listHeight + 8 && r.top > listHeight + 8 ? r.top - listHeight - 4 : r.bottom + 4;
    setPos({ top, left: r.left, minWidth: r.width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onPointer = (e) => {
      if (!listRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) close(false);
    };
    // The list is fixed-position, so it would drift away from the button on scroll.
    const onMove = () => close(false);
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  function onButtonKey(e) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openList();
    }
  }

  function onListKey(e) {
    const last = options.length - 1;
    const moves = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => choose(active),
      ' ': () => choose(active),
      Escape: () => close(),
      Tab: () => close(),
    };
    if (moves[e.key]) {
      if (e.key !== 'Tab') e.preventDefault();
      moves[e.key]();
    }
  }

  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className={`select-button${open ? ' open' : ''}`}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onButtonKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel ? `${ariaLabel}: ${selected?.label}` : undefined}
        disabled={disabled}
      >
        <span>{selected?.label}</span>
        <svg className="chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul
          id={listId}
          ref={listRef}
          className="select-list"
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
          style={pos ? { top: pos.top, left: pos.left, minWidth: pos.minWidth } : { visibility: 'hidden' }}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`select-option${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <svg className="check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="option-text">
                <span className="option-label">{o.label}</span>
                {o.hint && <span className="option-hint">{o.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
