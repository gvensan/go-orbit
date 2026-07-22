import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as d3 from "d3";

// ---------- deterministic data generation ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORGS = [
  { name: "Acme Corp", color: "#5eead4" },
  { name: "Globex", color: "#93c5fd" },
  { name: "Initech", color: "#f0abfc" },
  { name: "Umbrella", color: "#fca5a5" },
  { name: "Wayne Ent.", color: "#fcd34d" },
  { name: "Hooli", color: "#c4b5fd" },
];

// edge taxonomy — the whole point of the graph
const EDGE_TYPES = {
  colleague: { color: "#3b6ea5", label: "Colleague", width: 1 },
  family: { color: "#c2708e", label: "Family", width: 1.6 },
  introduced: { color: "#d9a441", label: "Introduced by", width: 1.4 },
  friend: { color: "#4c9a86", label: "Friend", width: 1 },
};

const FIRST = ["Ava","Liam","Noah","Emma","Olivia","Sophia","Mason","Lucas","Mia","Ethan","Isabella","Aiden","Riya","Arjun","Wei","Chen","Priya","Diego","Sofia","Yuki","Omar","Fatima","Kai","Nina","Leo","Zara","Ivan","Maya","Raj","Elena","Hana","Sven","Lucia","Amir","Grace","Tomas","Ines","Kofi","Lena","Paulo"];
const LAST = ["Chen","Patel","Kim","Garcia","Okafor","Nguyen","Silva","Haddad","Rossi","Novak","Khan","Torres","Ivanov","Tanaka","Mensah","Cohen","Reyes","Singh","Muller","Abbas"];
const ROLES = ["Eng Lead","Designer","PM","Founder","Analyst","Recruiter","Sales","Ops","Legal","Data Sci","Marketer","CFO"];

function generateGraph() {
  const rnd = mulberry32(42);
  const ri = (n) => Math.floor(rnd() * n);
  const N = 100;

  const nodes = [];
  for (let i = 0; i < N; i++) {
    // uneven org sizes: weighted pick
    let o = ri(ORGS.length);
    if (rnd() < 0.35) o = ri(3); // bias toward first few → varied cluster sizes
    nodes.push({
      id: i,
      name: `${FIRST[ri(FIRST.length)]} ${LAST[ri(LAST.length)]}`,
      org: o,
      role: ROLES[ri(ROLES.length)],
    });
  }

  const seen = new Set();
  const links = [];
  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const add = (a, b, type) => {
    if (a === b) return;
    const k = key(a, b);
    if (seen.has(k)) return;
    seen.add(k);
    links.push({ source: a, target: b, type });
  };

  // colleague edges within each org
  const byOrg = ORGS.map((_, o) => nodes.filter((n) => n.org === o).map((n) => n.id));
  byOrg.forEach((members) => {
    members.forEach((id) => {
      const deg = 1 + ri(3);
      for (let k = 0; k < deg; k++) add(id, members[ri(members.length)], "colleague");
    });
  });

  // family micro-clusters (small cliques, can cross orgs)
  for (let f = 0; f < 7; f++) {
    const size = 2 + ri(3);
    const fam = [];
    for (let k = 0; k < size; k++) fam.push(ri(N));
    for (let a = 0; a < fam.length; a++)
      for (let b = a + 1; b < fam.length; b++) add(fam[a], fam[b], "family");
  }

  // cross-org bridges — the interesting connectors
  for (let k = 0; k < 16; k++) add(ri(N), ri(N), "introduced");
  for (let k = 0; k < 12; k++) add(ri(N), ri(N), "friend");

  // degree
  const degree = new Array(N).fill(0);
  links.forEach((l) => {
    degree[l.source]++;
    degree[l.target]++;
  });
  nodes.forEach((n) => (n.degree = degree[n.id]));

  return { nodes, links };
}

// ---------- component ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export default function OrbitGraph() {
  const W = 900,
    H = 600;
  const { nodes, links } = useMemo(() => generateGraph(), []);
  const rScale = useMemo(() => {
    const max = d3.max(nodes, (n) => n.degree) || 1;
    return d3.scaleSqrt().domain([0, max]).range([3.5, 15]);
  }, [nodes]);

  const svgRef = useRef(null);
  const simRef = useRef(null);
  const dragRef = useRef(null); // {id, moved}
  const panRef = useRef(null); // {sx,sy,ox,oy}
  const [, setTick] = useState(0);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const [selected, setSelected] = useState(null);
  const [hover, setHover] = useState(null);

  // adjacency for ego-network highlighting
  const adj = useMemo(() => {
    const m = new Map(nodes.map((n) => [n.id, new Set()]));
    links.forEach((l) => {
      const s = l.source.id ?? l.source;
      const t = l.target.id ?? l.target;
      m.get(s).add(t);
      m.get(t).add(s);
    });
    return m;
  }, [nodes, links]);

  // force sim
  useEffect(() => {
    const sim = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance((l) => (l.type === "colleague" ? 34 : 78))
          .strength((l) => (l.type === "colleague" ? 0.7 : 0.12))
      )
      .force("charge", d3.forceManyBody().strength(-130))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide().radius((d) => rScale(d.degree) + 2))
      .on("tick", () => setTick((t) => t + 1));
    simRef.current = sim;
    return () => sim.stop();
  }, [nodes, links, rScale]);

  // wheel zoom (attach manually for non-passive preventDefault)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * W;
      const my = ((e.clientY - rect.top) / rect.height) * H;
      setTransform((t) => {
        const k = clamp(t.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3, 5);
        const r = k / t.k;
        return { k, x: mx - (mx - t.x) * r, y: my - (my - t.y) * r };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // screen → graph coords
  const toGraph = useCallback(
    (clientX, clientY) => {
      const rect = svgRef.current.getBoundingClientRect();
      const sx = ((clientX - rect.left) / rect.width) * W;
      const sy = ((clientY - rect.top) / rect.height) * H;
      return { x: (sx - transform.x) / transform.k, y: (sy - transform.y) / transform.k };
    },
    [transform]
  );

  const onNodeDown = (e, node) => {
    e.stopPropagation();
    dragRef.current = { id: node.id, moved: false };
    node.fx = node.x;
    node.fy = node.y;
    simRef.current.alphaTarget(0.25).restart();
  };
  const onBgDown = (e) => {
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: transform.x, oy: transform.y };
  };
  const onMove = (e) => {
    if (dragRef.current) {
      dragRef.current.moved = true;
      const p = toGraph(e.clientX, e.clientY);
      const n = nodes[dragRef.current.id];
      n.fx = p.x;
      n.fy = p.y;
    } else if (panRef.current) {
      const { sx, sy, ox, oy } = panRef.current;
      const rect = svgRef.current.getBoundingClientRect();
      const dx = ((e.clientX - sx) / rect.width) * W;
      const dy = ((e.clientY - sy) / rect.height) * H;
      setTransform((t) => ({ ...t, x: ox + dx, y: oy + dy }));
    }
  };
  const onUp = () => {
    if (dragRef.current) {
      const d = dragRef.current;
      const n = nodes[d.id];
      n.fx = null;
      n.fy = null;
      simRef.current.alphaTarget(0);
      if (!d.moved) setSelected((s) => (s === d.id ? null : d.id));
      dragRef.current = null;
    }
    panRef.current = null;
  };

  const resetView = () => setTransform({ k: 1, x: 0, y: 0 });

  // highlight sets
  const neigh = selected != null ? adj.get(selected) : null;
  const isDim = (id) =>
    selected != null && id !== selected && !(neigh && neigh.has(id));
  const linkActive = (l) => {
    if (selected == null) return true;
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    return s === selected || t === selected;
  };

  const sel = selected != null ? nodes[selected] : null;
  const selConns =
    sel && neigh
      ? [...neigh].map((id) => nodes[id]).sort((a, b) => b.degree - a.degree)
      : [];

  return (
    <div
      style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
      className="w-full min-h-screen bg-[#0a0f1c] text-slate-200 p-4 md:p-6"
    >
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.25em] text-slate-500 font-mono">
            Relationship graph · sample
          </div>
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-slate-100">
            100 contacts, mapped
          </h1>
        </div>
        <div className="flex items-center gap-5 font-mono text-xs text-slate-400">
          <Stat n={nodes.length} l="nodes" />
          <Stat n={links.length} l="edges" />
          <Stat n={ORGS.length} l="orgs" />
          <button
            onClick={resetView}
            className="ml-1 px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500 hover:text-slate-100 transition-colors"
          >
            Reset view
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4">
        {/* canvas */}
        <div className="relative rounded-xl overflow-hidden border border-slate-800 bg-[#070b16]">
          {/* subtle grid glow */}
          <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
              background:
                "radial-gradient(600px 400px at 50% 40%, rgba(56,89,150,0.12), transparent 70%)",
            }}
          />
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="w-full block touch-none select-none"
            style={{ aspectRatio: `${W}/${H}`, cursor: panRef.current ? "grabbing" : "default" }}
            onPointerDown={onBgDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
          >
            <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
              {/* edges */}
              {links.map((l, i) => {
                const s = l.source,
                  t = l.target;
                if (s.x == null || t.x == null) return null;
                const et = EDGE_TYPES[l.type];
                const active = linkActive(l);
                return (
                  <line
                    key={i}
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={et.color}
                    strokeWidth={et.width / transform.k}
                    strokeOpacity={selected == null ? 0.32 : active ? 0.85 : 0.05}
                  />
                );
              })}
              {/* nodes */}
              {nodes.map((n) => {
                if (n.x == null) return null;
                const r = rScale(n.degree);
                const dim = isDim(n.id);
                const isSel = n.id === selected;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x},${n.y})`}
                    onPointerDown={(e) => onNodeDown(e, n)}
                    onPointerEnter={() => setHover(n.id)}
                    onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                    style={{ cursor: "pointer" }}
                    opacity={dim ? 0.18 : 1}
                  >
                    {isSel && (
                      <circle r={(r + 5) / 1} fill="none" stroke={ORGS[n.org].color} strokeWidth={1.5 / transform.k} opacity={0.9} />
                    )}
                    <circle
                      r={r}
                      fill={ORGS[n.org].color}
                      stroke="#070b16"
                      strokeWidth={1.2 / transform.k}
                    />
                    {(hover === n.id || isSel || n.degree > 9) && (
                      <text
                        y={-r - 4 / transform.k}
                        textAnchor="middle"
                        fontSize={11 / transform.k}
                        fill="#e2e8f0"
                        style={{ pointerEvents: "none", fontFamily: "ui-monospace, monospace" }}
                      >
                        {n.name}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>

          {/* edge legend */}
          <div className="absolute left-3 bottom-3 flex flex-col gap-1.5 bg-[#070b16]/80 backdrop-blur px-3 py-2 rounded-lg border border-slate-800">
            {Object.entries(EDGE_TYPES).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
                <span className="inline-block w-4 h-[2px]" style={{ background: v.color }} />
                {v.label}
              </div>
            ))}
          </div>
          <div className="absolute right-3 top-3 text-[10px] font-mono text-slate-600">
            scroll = zoom · drag bg = pan · drag node = move · click = focus
          </div>
        </div>

        {/* side panel */}
        <div className="rounded-xl border border-slate-800 bg-[#070b16] p-4">
          {!sel ? (
            <div className="text-sm text-slate-500">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-600 mb-2">
                Organizations
              </div>
              <div className="flex flex-col gap-1.5 mb-5">
                {ORGS.map((o, i) => {
                  const count = nodes.filter((n) => n.org === i).length;
                  return (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2 text-slate-300">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: o.color }} />
                        {o.name}
                      </span>
                      <span className="font-mono text-slate-500">{count}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs leading-relaxed text-slate-500">
                Node size scales with degree — bigger dots are your connectors.
                Click any contact to isolate their network.
              </p>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-3 h-3 rounded-full" style={{ background: ORGS[sel.org].color }} />
                <h2 className="text-base font-semibold text-slate-100">{sel.name}</h2>
              </div>
              <div className="font-mono text-[11px] text-slate-500 mb-4">
                {sel.role} · {ORGS[sel.org].name}
              </div>
              <div className="flex gap-4 mb-4">
                <Stat n={sel.degree} l="connections" />
                <Stat n={selConns.filter((c) => c.org !== sel.org).length} l="cross-org" />
              </div>
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-600 mb-2">
                Connected to
              </div>
              <div className="flex flex-col gap-1 max-h-[300px] overflow-auto pr-1">
                {selConns.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    className="flex items-center justify-between text-xs text-left px-2 py-1 rounded hover:bg-slate-800/60"
                  >
                    <span className="flex items-center gap-2 text-slate-300">
                      <span className="w-2 h-2 rounded-full" style={{ background: ORGS[c.org].color }} />
                      {c.name}
                    </span>
                    <span className="font-mono text-slate-600">{c.degree}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setSelected(null)}
                className="mt-4 w-full text-xs font-mono text-slate-400 border border-slate-700 rounded py-1.5 hover:border-slate-500 hover:text-slate-100 transition-colors"
              >
                Clear focus
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ n, l }) {
  return (
    <div className="flex flex-col leading-none">
      <span className="text-lg font-semibold text-slate-100 tabular-nums">{n}</span>
      <span className="text-[10px] uppercase tracking-wider text-slate-500">{l}</span>
    </div>
  );
}
