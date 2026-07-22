// graphml.js - GraphML export of the live network (Nice tier: hand the graph
// to Gephi/yEd/networkx). Pure string building from a GraphSnapshot.

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** @param {import('../../shared/types').GraphSnapshot} snapshot */
function buildGraphML(snapshot) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="org" for="node" attr.name="org" attr.type="string"/>',
    '  <key id="role" for="node" attr.name="role" attr.type="string"/>',
    '  <key id="degree" for="node" attr.name="degree" attr.type="int"/>',
    '  <key id="type" for="edge" attr.name="type" attr.type="string"/>',
    '  <graph id="contacts" edgedefault="undirected">',
  ];
  for (const n of snapshot.nodes) {
    lines.push(`    <node id="n${n.id}">`);
    lines.push(`      <data key="name">${esc(n.name)}</data>`);
    if (n.org) lines.push(`      <data key="org">${esc(n.org)}</data>`);
    if (n.role) lines.push(`      <data key="role">${esc(n.role)}</data>`);
    lines.push(`      <data key="degree">${n.degree}</data>`);
    lines.push("    </node>");
  }
  snapshot.links.forEach((l, i) => {
    const directed = l.directed ? ' directed="true"' : "";
    lines.push(`    <edge id="e${i}" source="n${l.source}" target="n${l.target}"${directed}>`);
    lines.push(`      <data key="type">${esc(l.type)}</data>`);
    lines.push("    </edge>");
  });
  lines.push("  </graph>", "</graphml>", "");
  return lines.join("\n");
}

module.exports = { buildGraphML };
