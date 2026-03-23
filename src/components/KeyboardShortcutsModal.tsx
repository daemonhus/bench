import React, { useEffect } from 'react';

interface ShortcutEntry {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutEntry[];
}

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const MOD = isMac ? '\u2318' : 'Ctrl';
const ALT = isMac ? '\u2325' : 'Alt';
const SHIFT = '\u21E7';
const ENTER = '\u21B5';
const ESC = 'Esc';

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Search',
    shortcuts: [
      { keys: [MOD, 'F'], description: 'Find in file' },
      { keys: [MOD, SHIFT, 'F'], description: 'Find in all files' },
      { keys: [MOD, 'G'], description: 'Go to file' },
    ],
  },
  {
    title: 'Navigation',
    shortcuts: [
      { keys: [ALT, '\u2190'], description: 'Go back' },
      { keys: [ALT, '\u2192'], description: 'Go forward' },
      { keys: [MOD, '['], description: 'Go back' },
      { keys: [MOD, ']'], description: 'Go forward' },
    ],
  },
  {
    title: 'In-File Search',
    shortcuts: [
      { keys: [ENTER], description: 'Next match' },
      { keys: [SHIFT, ENTER], description: 'Previous match' },
      { keys: [ESC], description: 'Close search' },
    ],
  },
  {
    title: 'File Tree',
    shortcuts: [
      { keys: ['\u2191', '\u2193'], description: 'Navigate items' },
      { keys: ['\u2192'], description: 'Expand folder' },
      { keys: ['\u2190'], description: 'Collapse folder' },
      { keys: [ENTER], description: 'Open file / toggle folder' },
    ],
  },
  {
    title: 'Editing',
    shortcuts: [
      { keys: [MOD, ENTER], description: 'Submit form' },
      { keys: [ESC], description: 'Cancel / close' },
    ],
  },
];

interface KeyboardShortcutsModalProps {
  onClose: () => void;
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({ onClose }) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-header">
          <span className="shortcuts-title">Keyboard Shortcuts</span>
          <button className="shortcuts-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="shortcuts-body">
          {GROUPS.map((group) => (
            <div key={group.title} className="shortcuts-group">
              <div className="shortcuts-group-title">{group.title}</div>
              {group.shortcuts.map((shortcut, i) => (
                <div key={i} className="shortcuts-row">
                  <span className="shortcuts-keys">
                    {shortcut.keys.map((key, j) => (
                      <kbd key={j} className="shortcuts-kbd">{key}</kbd>
                    ))}
                  </span>
                  <span className="shortcuts-desc">{shortcut.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
