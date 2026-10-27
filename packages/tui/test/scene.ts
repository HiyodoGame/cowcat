import { line, type Line } from '../src/ui/line.js';
import type { SceneNode } from '../src/ui/scene.js';

export function rowsOf(nodes: readonly SceneNode[]): readonly Line[] {
  return nodes.flatMap((node): readonly Line[] => {
    switch (node.kind) {
      case 'text':
      case 'scrolltext': return node.rows;
      case 'stack':
      case 'block': return rowsOf(node.children);
      case 'panel': return [...rowsOf(node.children), ...rowsOf(node.actions ?? [])];
      case 'choice': return [line(node.text, node.token, node.selected, node.hit)];
      case 'status': return [line([node.activity, ...node.facts.map((fact) => `${fact.label} ${fact.value}`)].join(' · '), node.token)];
      case 'sprite': return [line('cow-sprite', 'text')];
      case 'image': return [];
    }
  });
}

export function textOf(nodes: readonly SceneNode[]): string {
  return rowsOf(nodes).map((row) => row.text).join('\n');
}

export function nodesOf(nodes: readonly SceneNode[]): readonly SceneNode[] {
  return nodes.flatMap((node): readonly SceneNode[] => [
    node,
    ...('children' in node ? nodesOf(node.children) : []),
    ...(node.kind === 'panel' ? nodesOf(node.actions ?? []) : []),
  ]);
}
