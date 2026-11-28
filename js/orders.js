/* Works out what to pick and the build steps for a website order from the parts
   lists set in Payaz Stock (Website orders > Parts lists). A copy of Payaz Stock's
   src/lib/orderRecipes.ts: change both together. */
const norm = (s) => String(s || "").trim().toLowerCase();

/** recipes: { [product_id]: recipe }. Returns { parts: [{ key, item_id, qty, why, line_id }], steps: [{ text, why, line_id }], missing: [product names] } */
export function planOrder(order, recipes) {
  const parts = [], steps = [], missing = [];
  for (const line of (order && order.lines) || []) {
    const r = recipes[String(line.product_id)];
    if (!r) { missing.push(line.name); continue; }
    if (r.nothing_to_pick) continue;
    const add = (list, why) => {
      for (const p of list || []) {
        if (!p || !p.item_id || !(p.qty > 0)) continue;
        const qty = p.qty * (line.qty || 1);
        const same = parts.find((x) => x.item_id === p.item_id && x.line_id === line.id && x.why === why);
        if (same) same.qty += qty; else parts.push({ key: `${line.id}|${p.item_id}|${why}`, item_id: p.item_id, qty, why, line_id: line.id });
      }
    };
    add(r.parts, line.name);
    (r.steps || []).filter(Boolean).forEach((text) => steps.push({ text, why: line.name, line_id: line.id }));
    for (const opt of line.options || []) {
      const rule = (r.options || []).find((o) => norm(o.key) === norm(opt.key) && norm(o.value) === norm(opt.value));
      if (!rule) continue;
      const why = `${opt.key}: ${opt.value}`;
      add(rule.parts, why);
      (rule.steps || []).filter(Boolean).forEach((text) => steps.push({ text, why, line_id: line.id }));
    }
  }
  return { parts, steps, missing };
}
