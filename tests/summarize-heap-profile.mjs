import { readFileSync } from 'node:fs';

const { profile } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const totals = new Map();
function visit(node, path = []) {
  const frame = node.callFrame;
  const label = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
  const next = [...path, label];
  if (node.selfSize) totals.set(next.join('\n  '), node.selfSize);
  for (const child of node.children) visit(child, next);
}
visit(profile.head);
for (const [path, bytes] of [...totals].sort((a,b)=>b[1]-a[1]).slice(0,20)) {
  console.log(`${(bytes/1048576).toFixed(1)} MiB\n  ${path}\n`);
}
