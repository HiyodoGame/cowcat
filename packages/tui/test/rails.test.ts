import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asideSpec, leftRailSpec } from '../src/app/rails.js';
import { initialView, type AgentView } from '../src/app/view.js';

test('empty activity rails keep fixed sections and explicit empty states', () => {
  const left = leftRailSpec(initialView(), [], 0);
  assert.deepEqual(left.panels.map((panel) => panel.title), ['待办 0/0', '子代理', '后台任务']);
  assert.deepEqual(left.panels.map((panel) => panel.rows[0]?.text), [
    '暂无待办', '暂无运行中的子代理', '暂无后台任务',
  ]);
  assert.ok(left.panels.every((panel) => panel.rows[0]?.dim));
});

test('non-empty activity rails preserve real rows in the approved order', () => {
  const agents: readonly AgentView[] = [{
    childSessionId: 'child', role: 'explore', description: 'inspect', state: 'running', turns: 1, startedAt: 0,
  }];
  const left = leftRailSpec({
    ...initialView(),
    todosVisible: true,
    todos: [{ content: 'write tests', status: 'in_progress', activeForm: 'writing tests' }],
    tasks: [{ taskId: 'bg', callId: 'call', command: 'npm test', startedAt: 0, startedSeq: 1, state: 'running', endedAt: null, exitCode: null }],
  }, agents, 5_000);
  assert.deepEqual(left.panels.map((panel) => panel.title), ['待办 0/1', '子代理', '后台任务']);
  assert.equal(left.panels[0]?.rows[0]?.text, 'writing tests');
  assert.equal(left.panels[1]?.rows[0]?.text, 'explore · 5s');
  assert.equal(left.panels[2]?.rows[0]?.text, 'npm test');
});

test('the information rail keeps an empty change section and real diffstat when present', () => {
  const empty = asideSpec(initialView(), { cwd: 'F:/project' }, []);
  assert.equal(empty.panels.at(-1)?.title, 'CowCat 变更');
  assert.equal(empty.panels.at(-1)?.rows[0]?.label, '暂无 CowCat 变更');
  assert.equal(empty.panels.at(-1)?.rows[0]?.value, '');

  const changed = asideSpec(initialView(), { cwd: 'F:/project' }, [{ path: 'F:/project/a.ts', added: 3, removed: 1, written: 0 }]);
  assert.equal(changed.panels.at(-1)?.rows[0]?.label, 'a.ts');
  assert.equal(changed.panels.at(-1)?.rows[0]?.value, '+3 -1');
});
