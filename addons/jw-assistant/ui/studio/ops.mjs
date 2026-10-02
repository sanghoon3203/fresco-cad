// Human-readable Patch v2 operations (op chips). Pure: shared by the Studio UI and tests.
const fmt = v => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const signed = v => (v > 0 ? `+${fmt(v)}` : fmt(v));
const pt = p => (Array.isArray(p) ? `(${fmt(p[0])}, ${fmt(p[1])})` : '');
const KIND = {
  ja: { line: '線', text: '文字', arc: '円弧', point: '点', solid: 'ソリッド', block: 'ブロック', dimension: '寸法' },
  en: { line: 'line', text: 'text', arc: 'arc', point: 'point', solid: 'solid', block: 'block', dimension: 'dimension' }
};
const FIELDS = {
  ja: { start: '始点', end: '終点', at: '位置', center: '中心', radius: '半径', startAngle: '開始角', sweepAngle: '角度', text: '文字', height: '高さ', width: '幅', angle: '角度' },
  en: { start: 'start', end: 'end', at: 'position', center: 'centre', radius: 'radius', startAngle: 'start angle', sweepAngle: 'sweep', text: 'text', height: 'height', width: 'width', angle: 'angle' }
};

/** { op, tone, label, detail, ids } for one (normalized or raw) Patch v2 op. tone drives the chip colour. */
export function describeOp(op, lang = 'ja') {
  const ja = lang !== 'en', n = op.ids?.length ?? (op.id ? 1 : 0), ids = op.ids ?? (op.id ? [op.id] : []);
  switch (op.op) {
    case 'translate': {
      const parts = [op.dx ? `X ${signed(op.dx)}` : '', op.dy ? `Y ${signed(op.dy)}` : ''].filter(Boolean).join(' / ');
      return { op: op.op, tone: 'move', ids, label: ja ? `${n}件を移動` : `Move ${n}`, detail: `${parts} mm` };
    }
    case 'delete': return { op: op.op, tone: 'remove', ids, label: ja ? `${n}件を削除` : `Delete ${n}`, detail: ids.slice(0, 4).join(', ') + (ids.length > 4 ? ' …' : '') };
    case 'add': {
      const e = op.entity ?? {}, kind = KIND[ja ? 'ja' : 'en'][e.kind] ?? e.kind;
      const what = e.kind === 'text' ? `「${String(e.text ?? '').slice(0, 24)}」` : e.kind === 'line' ? `${pt(e.start)} → ${pt(e.end)}` : e.kind === 'arc' ? `${pt(e.center)} R${fmt(e.radius)}` : pt(e.at);
      return { op: op.op, tone: 'add', ids: op.tempId ? [op.tempId] : [], label: ja ? `${kind}を追加` : `Add ${kind}`, detail: `${what} · ${ja ? 'レイヤ' : 'layer'} ${e.layer}` };
    }
    case 'modify': {
      const f = FIELDS[ja ? 'ja' : 'en'], set = Object.entries(op.set ?? {}).filter(([, v]) => v !== null && v !== undefined);
      const detail = set.map(([k, v]) => `${f[k] ?? k} ${Array.isArray(v) ? pt(v) : typeof v === 'string' ? `「${v.slice(0, 20)}」` : fmt(v)}`).join(' · ');
      return { op: op.op, tone: 'change', ids, label: ja ? `${op.id} を変更` : `Edit ${op.id}`, detail };
    }
    case 'setLayer': return { op: op.op, tone: 'change', ids, label: ja ? `${n}件のレイヤ変更` : `Relayer ${n}`, detail: `→ ${op.layer}` };
    case 'setPen': {
      const p = op.pen ?? {}, bits = [p.color != null ? (ja ? `線色 ${p.color}` : `colour ${p.color}`) : '', p.style != null ? (ja ? `線種 ${p.style}` : `type ${p.style}`) : '', p.width != null ? (ja ? `線幅 ${p.width}` : `width ${p.width}`) : ''];
      return { op: op.op, tone: 'change', ids, label: ja ? `${n}件の線属性` : `Pen ×${n}`, detail: bits.filter(Boolean).join(' · ') };
    }
    default: return { op: String(op.op), tone: 'change', ids, label: String(op.op), detail: '' };
  }
}

/** One-line summary ("移動 ×2 · 削除") for toasts and the history. */
export function summarizeOps(ops, lang = 'ja') {
  const names = { ja: { translate: '移動', delete: '削除', add: '追加', modify: '変更', setLayer: 'レイヤ変更', setPen: '線属性' },
    en: { translate: 'Move', delete: 'Delete', add: 'Add', modify: 'Edit', setLayer: 'Relayer', setPen: 'Pen' } }[lang === 'en' ? 'en' : 'ja'];
  const counts = new Map();
  for (const op of ops ?? []) counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
  return [...counts].map(([k, c]) => (c > 1 ? `${names[k] ?? k} ×${c}` : names[k] ?? k)).join(' · ');
}
