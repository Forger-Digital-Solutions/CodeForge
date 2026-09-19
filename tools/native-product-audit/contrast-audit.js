// Evaluated inside the renderer: WCAG contrast of visible text against the nearest opaque background.
(() => {
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(Number); return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }; };
  const blend = (fg, a, bg) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
  const bgOf = (el) => { let e = el; let acc = null; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { if (c.a >= 0.99) return acc ? blend(acc.rgb, acc.a, c.rgb) : c.rgb; if (!acc) acc = c; } e = e.parentElement; } const base = [15, 16, 18]; return acc ? blend(acc.rgb, acc.a, base) : base; };
  const low = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; let checked = 0;
  while ((n = walker.nextNode()) && checked < 5000) {
    const t = n.textContent.trim(); if (!t || t.length < 2) continue;
    const el = n.parentElement; if (!el) continue;
    const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
    if (r.bottom < 0 || r.top > document.documentElement.clientHeight) continue;
    const cs = getComputedStyle(el); if (cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const fg = parse(cs.color); if (!fg) continue;
    checked++;
    const bg = bgOf(el);
    const fgRgb = fg.a < 1 ? blend(fg.rgb, fg.a, bg) : fg.rgb;
    const l1 = lum(fgRgb), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const threshold = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (ratio < threshold) low.push({ text: t.slice(0, 40), ratio: Math.round(ratio * 100) / 100, fontSize: size, color: cs.color, bg: "rgb(" + bg.join(",") + ")", cls: String(el.className).slice(0, 60) });
  }
  low.sort((a, b) => a.ratio - b.ratio);
  const byClass = {};
  for (const l of low) { byClass[l.cls] = byClass[l.cls] || { count: 0, worst: l.ratio, sample: l.text }; byClass[l.cls].count++; }
  return { checked, lowContrastCount: low.length, lowest: low.slice(0, 25), byClass };
})()
