// Diff folding cards (brand guide §5.2 "diff 视图"): unified-diff generation,
// middle folding, regex-level syntax tinting, multi-file grouping. Zero deps.

// --- line diff (LCS) -------------------------------------------------------

export function computeLineDiff(aLines, bLines) {
  const n = aLines.length;
  const m = bLines.length;
  // edit scenarios are small; beyond this, degrade to a single replace-everything hunk
  if (n * m > 4_000_000) {
    return [
      ...aLines.map((line) => ({ sign: '-', line })),
      ...bLines.map((line) => ({ sign: '+', line })),
    ];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { ops.push({ sign: ' ', line: aLines[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ sign: '-', line: aLines[i] }); i++; }
    else { ops.push({ sign: '+', line: bLines[j] }); j++; }
  }
  while (i < n) ops.push({ sign: '-', line: aLines[i++] });
  while (j < m) ops.push({ sign: '+', line: bLines[j++] });
  return ops;
}

// --- unified diff with hunks ----------------------------------------------

// Returns items: {kind:'hunk', header} | {kind:'line', sign, text, oldNo, newNo}
export function unifiedDiff(oldText, newText, { context = 2 } = {}) {
  const splitLines = (t) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = computeLineDiff(a, b);
  const items = [];
  const changes = [];
  ops.forEach((op, idx) => {
    if (op.sign !== ' ') changes.push(idx);
    void idx;
  });
  // group change indices into hunks with <= 2*context gap
  const hunks = [];
  for (const idx of changes) {
    const last = hunks[hunks.length - 1];
    if (last && idx - last.end <= context * 2) last.end = idx;
    else hunks.push({ start: idx, end: idx });
  }
  let opIdx = 0;
  let oldNo = 1; let newNo = 1;
  const advance = (op) => {
    if (op.sign !== '+') oldNo++;
    if (op.sign !== '-') newNo++;
  };
  for (const h of hunks) {
    const ctxStart = Math.max(0, h.start - context);
    const ctxEnd = Math.min(ops.length - 1, h.end + context);
    while (opIdx < ctxStart) advance(ops[opIdx++]); // unchanged gap: count but don't emit
    let hunkOld = 0; let hunkNew = 0;
    const hunkItems = [];
    while (opIdx <= ctxEnd && opIdx < ops.length) {
      const op = ops[opIdx++];
      if (op.sign === ' ') { hunkItems.push({ kind: 'line', sign: ' ', text: op.line, oldNo: oldNo, newNo: newNo }); oldNo++; newNo++; hunkOld++; hunkNew++; }
      else if (op.sign === '-') { hunkItems.push({ kind: 'line', sign: '-', text: op.line, oldNo: oldNo, newNo: null }); oldNo++; hunkOld++; }
      else { hunkItems.push({ kind: 'line', sign: '+', text: op.line, oldNo: null, newNo: newNo }); newNo++; hunkNew++; }
    }
    const aStart = hunkItems.find((x) => x.oldNo != null)?.oldNo ?? oldNo;
    const bStart = hunkItems.find((x) => x.newNo != null)?.newNo ?? newNo;
    items.push({ kind: 'hunk', header: `@@ -${aStart},${hunkOld} +${bStart},${hunkNew} @@` });
    items.push(...hunkItems);
  }
  while (opIdx < ops.length) advance(ops[opIdx++]);
  const stats = ops.reduce((s, op) => {
    if (op.sign === '+') s.added++;
    if (op.sign === '-') s.removed++;
    return s;
  }, { added: 0, removed: 0 });
  return { items, ...stats };
}

// --- folding ---------------------------------------------------------------

export function foldItems(items, maxLines = 12) {
  if (items.length <= maxLines) return { items, collapsed: 0 };
  const head = Math.ceil(maxLines / 2);
  const tail = Math.floor(maxLines / 2);
  const collapsed = items.length - head - tail;
  return {
    items: [...items.slice(0, head), { kind: 'fold', count: collapsed }, ...items.slice(items.length - tail)],
    collapsed,
  };
}

// --- naive syntax tinting (strings / comments / keywords) ------------------

const TOKEN_RE = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|import|export|from|if|else|for|while|class|new|await|async|throw|try|catch|default|extends)\b/g;
const TINT = { comment: '\x1b[90m', string: '\x1b[38;5;220m', keyword: '\x1b[38;5;75m' };
const RESET = '\x1b[0m';

export function highlightCode(line, colors) {
  if (!colors) return line;
  return line.replace(TOKEN_RE, (m, comment, str, kw) => {
    const c = comment ? TINT.comment : str ? TINT.string : TINT.keyword;
    return `${c}${m}${RESET}`;
  });
}

// --- rendering -------------------------------------------------------------

const C = { red: '\x1b[38;5;167m', green: '\x1b[38;5;71m', gray: '\x1b[90m', reset: '\x1b[0m' };

// preview: {path, isNew, items, added, removed}
// `gutter` (TUI only) adds old/new line-number columns and tints the hunk
// header with the permission color; the line-mode UI keeps the plain layout.
export function renderFileCard(preview, { colors = true, maxLines = 12, pad = '  ', gutter = false, theme = null } = {}) {
  const { items, collapsed } = foldItems(preview.items, maxLines);
  const mode = preview.isNew ? 'new file' : 'modified';
  const stat = `+${preview.added} -${preview.removed}`;
  const hunkColor = gutter && theme?.permission ? theme.permission : C.gray;
  const noColor = (n) => (n == null ? '   ' : String(n).padStart(3));
  const lines = [`${pad}┌─ ${preview.path}  (${mode}, ${stat})`];
  for (const it of items) {
    if (it.kind === 'hunk') {
      lines.push(colors ? `${pad}│ ${hunkColor}${it.header}${C.reset}` : `${pad}${it.header}`);
    } else if (it.kind === 'fold') {
      const m = `··· (${it.count} lines collapsed) ···`;
      lines.push(colors ? `${pad}│ ${C.gray}${m}${C.reset}` : `${pad}${m}`);
    } else {
      const sign = it.sign;
      const body = highlightCode(it.text, colors);
      const nums = gutter ? `${noColor(it.oldNo)} ${noColor(it.newNo)} ` : '';
      if (!colors) {
        lines.push(`${pad}${nums}${sign} ${body}`);
      } else if (sign === '+') {
        lines.push(`${pad}│ ${nums}${C.green}+${C.reset} ${body}`);
      } else if (sign === '-') {
        lines.push(`${pad}│ ${nums}${C.red}-${C.reset} ${body}`);
      } else {
        lines.push(`${pad}│ ${nums}${C.gray} ${C.reset} ${body}`);
      }
    }
  }
  lines.push(`${pad}└─`);
  return lines;
}

// >3 files collapse to a file list; /diff expands individually.
export function renderGroup(previews, { colors = true, maxFiles = 3, maxLines = 12, gutter = false, theme = null } = {}) {
  if (previews.length > maxFiles) {
    const lines = ['  ┌─ changes (4+ files) ─'];
    for (const p of previews) {
      const stat = p.isNew ? 'new' : `+${p.added} -${p.removed}`;
      lines.push(`  │ ${p.path}  (${stat})`);
    }
    lines.push('  └─ /diff to expand each file');
    return lines;
  }
  return previews.flatMap((p, i) => renderFileCard(p, { colors, maxLines, pad: '  ', gutter, theme }).concat(i < previews.length - 1 ? [''] : []));
}
