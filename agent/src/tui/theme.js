// Semantic color tokens: single source of TUI palettes. Dark/light RGB values
// follow the Claude Code reverse-engineered spec; xterm-256 levels are
// hand-picked nearest approximations (hue preserved over raw distance), 16
// levels mirror the original ansi fallbacks.

export const TOKENS = [
  'brand', 'permission', 'promptBorder', 'text', 'inactive', 'subtle',
  'success', 'error', 'warning', 'bashBorder', 'userBubbleBg', 'bashBubbleBg',
  'planMode', 'autoAccept', 'diffAddedFg', 'diffAddedBg',
  'diffRemovedFg', 'diffRemovedBg',
];

const BACKGROUND_TOKENS = new Set([
  'userBubbleBg', 'bashBubbleBg', 'diffAddedBg', 'diffRemovedBg',
]);

const RGB = {
  dark: {
    brand: [215, 119, 87],
    permission: [177, 185, 249],
    promptBorder: [136, 136, 136],
    text: [255, 255, 255],
    inactive: [153, 153, 153],
    subtle: [80, 80, 80],
    success: [78, 186, 101],
    error: [255, 107, 128],
    warning: [255, 193, 7],
    bashBorder: [253, 93, 177],
    userBubbleBg: [55, 55, 55],
    bashBubbleBg: [65, 60, 65],
    planMode: [72, 150, 140],
    autoAccept: [175, 135, 255],
    diffAddedFg: [78, 186, 101],
    diffAddedBg: [24, 70, 35],
    diffRemovedFg: [255, 107, 128],
    diffRemovedBg: [70, 30, 35],
  },
  light: {
    brand: [215, 119, 87],
    permission: [87, 105, 247],
    promptBorder: [153, 153, 153],
    text: [0, 0, 0],
    inactive: [102, 102, 102],
    subtle: [175, 175, 175],
    success: [44, 122, 57],
    error: [171, 43, 63],
    warning: [150, 108, 30],
    bashBorder: [255, 0, 135],
    userBubbleBg: [240, 240, 240],
    bashBubbleBg: [250, 245, 250],
    planMode: [0, 102, 102],
    autoAccept: [135, 0, 255],
    diffAddedFg: [47, 157, 68],
    diffAddedBg: [199, 225, 203],
    diffRemovedFg: [209, 69, 75],
    diffRemovedBg: [253, 210, 216],
  },
};

const CUBE256 = {
  dark: {
    brand: 209,
    permission: 147,
    promptBorder: 102,
    text: 231,
    inactive: 246,
    subtle: 239,
    success: 78,
    error: 204,
    warning: 220,
    bashBorder: 205,
    userBubbleBg: 237,
    bashBubbleBg: 238,
    planMode: 73,
    autoAccept: 141,
    diffAddedFg: 78,
    diffAddedBg: 22,
    diffRemovedFg: 204,
    diffRemovedBg: 52,
  },
  light: {
    brand: 209,
    permission: 63,
    promptBorder: 246,
    text: 16,
    inactive: 241,
    subtle: 145,
    success: 29,
    error: 125,
    warning: 94,
    bashBorder: 198,
    userBubbleBg: 255,
    bashBubbleBg: 231,
    planMode: 23,
    autoAccept: 93,
    diffAddedFg: 29,
    diffAddedBg: 194,
    diffRemovedFg: 167,
    diffRemovedBg: 224,
  },
};

const ANSI16 = {
  dark: {
    brand: 91,
    permission: 94,
    promptBorder: 37,
    text: 97,
    inactive: 37,
    subtle: 37,
    success: 92,
    error: 91,
    warning: 93,
    bashBorder: 95,
    userBubbleBg: 100,
    bashBubbleBg: 40,
    planMode: 96,
    autoAccept: 95,
    diffAddedFg: 92,
    diffAddedBg: 42,
    diffRemovedFg: 91,
    diffRemovedBg: 41,
  },
  light: {
    brand: 91,
    permission: 34,
    promptBorder: 37,
    text: 30,
    inactive: 90,
    subtle: 90,
    success: 32,
    error: 31,
    warning: 33,
    bashBorder: 35,
    userBubbleBg: 47,
    bashBubbleBg: 47,
    planMode: 36,
    autoAccept: 35,
    diffAddedFg: 32,
    diffAddedBg: 42,
    diffRemovedFg: 31,
    diffRemovedBg: 41,
  },
};

function sgr(token, name, level) {
  const bg = BACKGROUND_TOKENS.has(token);
  if (level === '24bit') {
    const [r, g, b] = RGB[name][token];
    return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`;
  }
  if (level === '256') {
    return `\x1b[${bg ? 48 : 38};5;${CUBE256[name][token]}m`;
  }
  return `\x1b[${ANSI16[name][token]}m`;
}

export function getTheme(name, level = '256') {
  if (name !== 'dark' && name !== 'light') {
    throw new Error(`unknown theme: ${name}`);
  }
  if (level !== '16' && level !== '256' && level !== '24bit') {
    throw new Error(`unknown color level: ${level}`);
  }
  const theme = {};
  for (const token of TOKENS) theme[token] = sgr(token, name, level);
  return theme;
}
