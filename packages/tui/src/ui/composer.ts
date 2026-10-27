import { BoxRenderable, TextareaRenderable, type CliRenderer } from '@opentui/core';
import type { Theme } from '../theme/tokens.js';
import { resolveToken } from './primitives.js';

export function createComposer(renderer: CliRenderer, theme: Theme, parent: BoxRenderable) {
  const box = new BoxRenderable(renderer, {
    id: 'cowcat-input-box', width: '100%', height: 3, border: true, borderStyle: 'rounded',
    borderColor: resolveToken(theme, 'border'), flexDirection: 'row', flexShrink: 0,
    paddingLeft: 1, paddingRight: 1, bottomTitle: ' Enter 发送 ', bottomTitleAlignment: 'right',
  });
  const input = new TextareaRenderable(renderer, {
    id: 'cowcat-input', flexGrow: 1,
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      { name: 'return', meta: true, action: 'newline' },
      { name: 'j', ctrl: true, action: 'newline' },
      { name: 'linefeed', action: 'newline' },
    ],
  });
  box.add(input);
  parent.add(box);
  return {
    input,
    setPlaceholder(value: string) { input.placeholder = value; },
    clear() { input.setText(''); box.height = 3; },
    set(text: string) {
      input.setText(text);
      box.height = Math.min(6, Math.max(1, text.split('\n').length)) + 2;
      input.gotoBufferEnd();
      input.focus();
    },
    syncSize() {
      const next = Math.min(6, Math.max(1, input.plainText.split('\n').length)) + 2;
      if (box.height !== next) box.height = next;
    },
    height() { return box.height; },
  };
}
