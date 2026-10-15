// NotebookEdit tool: cell-level editing of .ipynb files. Kept separate from
// Edit because a notebook's source is JSON with per-cell structure — string
// replacement there is both fragile and blind to cell identity.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { editNotebook } from '../notebook.js';

export const NotebookEditTool = {
  name: 'NotebookEdit',
  description: `Edit a Jupyter notebook (.ipynb) one cell at a time.

How it works: cells are addressed by the 0-based index Read shows (\`--- cell [n] type ---\`). The new source is written verbatim; metadata, outputs, the other cells and the file's own formatting are preserved.
When to use: changing a notebook cell's source, inserting a cell, or deleting one. Read the notebook first — the index you pass must be one you have actually seen.
When NOT to use: editing the notebook's raw JSON by hand or touching non-notebook files (use Edit/Write), or editing a cell's stored output (outputs are produced by running the notebook, not by editing it).
Rules the tool enforces, and why:
- edit_mode replaces cell_index in place by default (\`replace\`, source and/or cell_type). \`insert\` places a new cell AT cell_index, shifting that cell and everything after it down; cell_index equal to the cell count appends at the end. \`delete\` removes cell_index.
- After an insert or delete every later index shifts, so re-Read before addressing cells again.
- Switching a cell to code keeps an \`outputs\` array (empty); switching away from code drops the stale outputs/execution_count.
Failure modes: out-of-range or non-integer cell_index, a file that is not valid notebook JSON, and replace/insert without new_source are reported as errors — fix the call, do not retry it unchanged.`,
  input_schema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Absolute path of the .ipynb file to edit' },
      cell_index: { type: 'number', description: '0-based index of the target cell, as shown by Read' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'replace (default) | insert (at cell_index) | delete' },
      new_source: { type: 'string', description: 'New cell source; required for replace and insert, ignored for delete' },
      cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Cell type; for insert defaults to code, for replace only changes it when given' },
    },
    required: ['notebook_path', 'cell_index'],
  },
  execute(input, ctx) {
    const filePath = resolve(ctx.cwd, input.notebook_path);
    if (!existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` };
    if (!ctx.readSet.has(filePath)) {
      return { ok: false, error: `Notebook has not been read yet in this session. Read ${filePath} first so the cell indices you pass are the ones on disk.` };
    }
    const text = readFileSync(filePath, 'utf8');
    const result = editNotebook(text, {
      cell_index: input.cell_index,
      edit_mode: input.edit_mode,
      new_source: input.new_source,
      cell_type: input.cell_type,
    });
    if (!result.ok) return { ok: false, error: `${result.error}${/range/.test(result.error) ? ' (Read the notebook to see the current cell indices)' : ''}` };
    writeFileSync(filePath, result.text);
    return {
      ok: true,
      output: `Edited ${filePath}: ${result.summary}.`
        + (input.edit_mode === 'insert' || input.edit_mode === 'delete'
          ? ' Cell indices after the edit point have shifted — re-Read the notebook before editing cells by index again.'
          : ''),
    };
  },
};
