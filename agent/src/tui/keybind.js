// Declarative keybind table + chord dispatcher, modeled on Open Code's
// config/keybind.ts: bindings are data (name / default chords / description /
// mode), user overrides replace defaults by name, and resolution walks a mode
// stack (modal > composer > global) so the highest-priority layer that binds a
// chord wins. Pure logic — no terminal I/O.

// Raw stdin sequence -> normalized chord name. Single printable characters
// normalize to themselves; control keys and CSI/SS3 sequences get stable names.
const RAW_TO_CHORD = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x1b': 'escape',
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[3~': 'delete',
  '\x1b[Z': 'shift+tab',
  '\x1b[1;2A': 'shift+up',
  '\x1b[1;2B': 'shift+down',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[15;5~': 'f3',
  '\x1bOj': 'f3',
  '\x0f': 'ctrl+o',
  '\x10': 'ctrl+p',
  '\x02': 'ctrl+b',
  '\x07': 'ctrl+g',
  '\x0a': 'ctrl+j',
  '\x17': 'ctrl+w',
  '\x15': 'ctrl+u',
  '\x0b': 'ctrl+k',
  '\x01': 'ctrl+a',
  '\x05': 'ctrl+e',
  '\x1bf': 'alt+f',
  '\x1b[b': 'alt+b', // fallback casing some terminals send
  '\x1bb': 'alt+b',
  '\x1b[1;5C': 'ctrl+right',
  '\x1b[1;5D': 'ctrl+left',
  '\x1b[13;2u': 'shift+enter',
};

// Normalize a raw chunk (already split to one key by the dispatcher) to a
// chord name. Unknown escape sequences keep their raw form so callers can
// ignore them; printable characters pass through verbatim.
export function normalizeKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  if (RAW_TO_CHORD[raw]) return RAW_TO_CHORD[raw];
  if (raw.length === 1) return raw;
  return raw;
}

// Every hardcoded key in the pre-refactor TuiUI._handleKey, moved into data.
// mode: 'modal' (inline approval), 'composer' (while the editor is reading),
// 'global' (always available, editor or not).
const kb = (name, keys, mode, description) => ({ name, keys, mode, description });

export const DEFAULT_KEYBINDS = [
  // --- modal: permission prompt pills (←→/h/l cycle, enter confirms, esc
  // denies — the safest option) ----------------------------------------------
  kb('approval.left', ['left', 'h'], 'modal', 'Move to the previous permission option'),
  kb('approval.right', ['right', 'l'], 'modal', 'Move to the next permission option'),
  kb('approval.confirm', ['enter'], 'modal', 'Confirm the selected permission option'),
  kb('approval.deny', ['escape'], 'modal', 'Deny (the safest option)'),
  kb('approval.scroll.up', ['up'], 'modal', 'Scroll the diff preview up'),
  kb('approval.scroll.down', ['down'], 'modal', 'Scroll the diff preview down'),
  // --- composer: text editing while a readLine is active --------------------
  kb('editor.left', ['left'], 'composer', 'Move cursor left'),
  kb('editor.right', ['right'], 'composer', 'Move cursor right'),
  kb('editor.history.prev', ['up'], 'composer', 'Previous history item'),
  kb('editor.history.next', ['down'], 'composer', 'Next history item'),
  kb('editor.tab', ['tab'], 'composer', 'Cycle completions / insert tab'),
  kb('editor.backspace', ['backspace'], 'composer', 'Delete character before cursor'),
  kb('editor.delete', ['delete'], 'composer', 'Delete character under cursor'),
  kb('editor.home', ['home'], 'composer', 'Move to start of line'),
  kb('editor.end', ['end'], 'composer', 'Move to end of line'),
  kb('editor.line.home', ['ctrl+a'], 'composer', 'Move to start of line (readline)'),
  kb('editor.line.end', ['ctrl+e'], 'composer', 'Move to end of line (readline)'),
  kb('editor.kill.word', ['ctrl+w'], 'composer', 'Delete word before cursor'),
  kb('editor.kill.start', ['ctrl+u'], 'composer', 'Delete to start of line'),
  kb('editor.kill.end', ['ctrl+k'], 'composer', 'Delete to end of line'),
  kb('editor.word.forward', ['alt+f', 'ctrl+right'], 'composer', 'Move to next word'),
  kb('editor.word.backward', ['alt+b', 'ctrl+left'], 'composer', 'Move to previous word'),
  // --- global: work with or without an active readLine ----------------------
  kb('editor.newline', ['ctrl+j', 'shift+enter'], 'global', 'Insert a newline / enter multiline mode'),
  kb('scroll.up', ['shift+up'], 'global', 'Scroll transcript up'),
  kb('scroll.down', ['shift+down'], 'global', 'Scroll transcript down'),
  kb('scroll.page.up', ['pageup'], 'global', 'Scroll transcript up one page'),
  kb('scroll.page.down', ['pagedown'], 'global', 'Scroll transcript down one page'),
  kb('mode.switch', ['shift+tab'], 'global', 'Switch act/plan mode'),
  kb('card.toggle', ['ctrl+o', 'f3'], 'global', 'Expand/collapse the latest card'),
  kb('app.escape', ['escape'], 'global', 'Cancel completion / dismiss menu / interrupt'),
  kb('prompt.submit', ['enter'], 'global', 'Submit the current input'),
  kb('app.commandPalette', ['ctrl+p'], 'global', 'Open the command palette'),
  kb('app.panel', ['ctrl+b'], 'global', 'Toggle the right sidebar panel'),
  kb('app.sessions', ['ctrl+g'], 'global', 'Open the recent-session list'),
  kb('app.help', ['?', '\x1b[107;7u'], 'global', 'Open the keybinding help panel'),
];

// Parse user overrides onto the defaults. Overrides: { name: value } where
// value is a comma-separated chord string, an array of chords, or false/'none'
// to unbind. Unknown names throw — typos must not silently vanish.
export function parseKeybinds(overrides = {}) {
  const known = new Set(DEFAULT_KEYBINDS.map((d) => d.name));
  const invalid = Object.keys(overrides).filter((k) => !known.has(k));
  if (invalid.length) {
    throw new Error(`Unrecognized keybind${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}`);
  }
  return DEFAULT_KEYBINDS.map((def) => {
    const override = overrides[def.name];
    if (override === undefined) return { ...def };
    if (override === false || override === 'none') return { ...def, keys: [] };
    const chords = Array.isArray(override)
      ? override.flatMap((v) => String(v).split(','))
      : String(override).split(',');
    return { ...def, keys: chords.map((c) => c.trim()).filter(Boolean) };
  });
}

// A resolvable keymap: chord -> command per mode, built from parsed binds.
export function createKeymap(overrides = {}) {
  const defs = parseKeybinds(overrides);
  const byMode = { modal: new Map(), composer: new Map(), global: new Map() };
  for (const def of defs) {
    for (const chord of def.keys) {
      // first definition of a chord within a mode wins (table order is
      // deliberate; duplicates across modes are the point of the stack)
      if (!byMode[def.mode].has(chord)) byMode[def.mode].set(chord, def.name);
    }
  }
  return {
    defs,
    // modeStack: ordered highest-priority first, e.g. ['modal','composer','global']
    resolve(modeStack, raw) {
      const chord = normalizeKey(raw);
      for (const mode of modeStack) {
        const map = byMode[mode];
        if (map && map.has(chord)) return map.get(chord);
      }
      return null;
    },
    // raw chord lookup without normalization (for case-insensitive modal keys)
    resolveChord(modeStack, chord) {
      for (const mode of modeStack) {
        const map = byMode[mode];
        if (map && map.has(chord)) return map.get(chord);
      }
      return null;
    },
  };
}
