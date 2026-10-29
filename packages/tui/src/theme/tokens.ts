/**
 * The theme's semantic tokens (ADR-061).
 *
 * The COLOURS come from the brand guide's table (`docs/brand/brand-guide.md` §3.1): the
 * product's palette is decided there, and a TUI that invented its own greens would be
 * off-brand in the one place a user stares at all day. What this module adds is the
 * VOCABULARY — a component asks for `tool`, `approval` or `alert`, never for `#A8C34A`.
 * Two reasons that matters, and neither is tidiness:
 *
 *   * the guide keeps `primary` (brand green) and `accent` (the fluorescent one, ≤3% of
 *     the screen) deliberately apart, and a literal hex in a component is how they get
 *     confused;
 *   * a token is the unit a later theme (light/dark, user override, T8) replaces without
 *     touching a single component.
 *
 * `text` is `default` on purpose: the terminal's own foreground is the only colour that is
 * guaranteed to be readable on the user's background, and the guide's rule for the banner
 * and status bar is "readable everywhere, including 80 columns and no ANSI".
 */
export const BRAND = {
  ink: '#141419',
  paper: '#F7F5F0',
  surface: '#EDEAE2',
  surfaceDark: '#2A2A33',
  /** Links, key actions, the wordmark. The brand accent. */
  primary: '#A8C34A',
  /** The completion moment only. Never text, never more than a sliver of the screen. */
  accent: '#C8F542',
  /** Act mode (aligned with Cline's blue). */
  act: '#4A9EDA',
  /** Plan mode (aligned with Cline's amber). */
  plan: '#E0A63C',
  /** Errors and dangerous commands. */
  alert: '#E05C4A',
} as const;

export type TokenName =
  | 'text'
  | 'textDim'
  | 'brand'
  | 'accent'
  | 'act'
  | 'plan'
  | 'alert'
  | 'border'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'notice'
  | 'catBackdrop'
  | 'catOn'
  | 'catFurDark'
  | 'catFurMid'
  | 'catFurLight'
  | 'catIris'
  | 'catNose'
  | 'catEye'
  | 'catHighlight'
  /** Markdown code (fenced blocks, inline code) — non-conversation content, act-blue family (ADR-162). */
  | 'code';

/**
 * A colour, or `null` for "whatever the terminal already uses".
 *
 * `null` rather than the string `'default'` because opentui's `parseColor` treats any
 * string that is not a known name as a HEX value: `'default'` is not a name in its table,
 * so it becomes a warning and magenta (`chunk-node-p43t2gam.js:3432-3440`). The terminal's
 * own foreground is reachable only through `RGBA.defaultForeground()`, and that call is the
 * renderer adapter's — this module stays free of it on purpose, so the theme and the
 * components can be imported (and tested) without loading a native renderer.
 */
export type TokenColor = string | null;

export interface Theme {
  readonly foreground: Readonly<Record<TokenName, TokenColor>>;
}

/**
 * The one theme T7 ships.
 *
 * `textDim` and `border` are the only two values not straight out of the guide's table:
 * it lists a dark background (`#1B1B22`) and a dark card surface (`#2A2A33`) but no
 * muted-foreground role, and a UI with no way to say "this is secondary" ends up using the
 * alert red for it. They are derived from the same neutral family, and a light theme (T8)
 * is where the pair gets revisited.
 */
export const THEME: Theme = {
  foreground: {
    // `null` = the terminal's own foreground. The only colour guaranteed to be readable on
    // whatever background the user runs.
    text: null,
    textDim: '#8A8A94',
    brand: BRAND.primary,
    accent: BRAND.accent,
    act: BRAND.act,
    plan: BRAND.plan,
    alert: BRAND.alert,
    border: '#3A3A44',
    // Whose voice a line is in. The user speaks in the Act blue, the agent in the brand
    // green — the two the guide keeps apart from `accent`.
    user: BRAND.act,
    assistant: BRAND.primary,
    tool: '#8A8A94',
    notice: BRAND.plan,
    catBackdrop: '#2F2F35',
    catOn: BRAND.paper,
    catFurDark: '#45454C',
    catFurMid: '#626269',
    catFurLight: '#85858C',
    catIris: '#D4D4D2',
    catNose: '#A0A0A5',
    catEye: '#77777F',
    catHighlight: BRAND.paper,
    code: BRAND.act,
  },
};

/** The colour a token resolves to, which for `text` is "let the terminal decide". */
export function colorOf(theme: Theme, token: TokenName): TokenColor {
  return theme.foreground[token];
}
