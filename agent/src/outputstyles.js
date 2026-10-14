// Output styles: ~/.cowcat/output-styles/<name>.md + project .cowcat/output-styles/<name>.md
// (project wins). frontmatter: description; body = style instructions appended
// to the system prompt tail while the style is active. Default = no style.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cowcatHome } from './config.js';

function parseStyle(raw, file) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { error: `缺少 frontmatter：${file}` };
  const desc = (m[1].match(/^description\s*:\s*(.*)$/m) || [])[1];
  if (!desc) return { error: `frontmatter 缺 description：${file}` };
  return { style: { description: desc.trim(), body: m[2].trim() } };
}

export function loadOutputStyles(cwd) {
  const styles = {};
  const warnings = [];
  for (const dir of [join(cowcatHome(), 'output-styles'), join(cwd, '.cowcat', 'output-styles')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const file = join(dir, name);
      const parsed = parseStyle(readFileSync(file, 'utf8'), file);
      if (parsed.error) { warnings.push(`⚠ ${parsed.error}`); continue; }
      styles[name.replace(/\.md$/, '')] = parsed.style;
    }
  }
  return { styles, warnings };
}

export function styleSection(body) {
  return `# Output style\n\nThe following output style is active for this session. Follow it for all replies.\n\n${body}`;
}
