const B = "http://127.0.0.1:5000";
const j = async (m, u, b) => {
  const r = await fetch(B + u, {
    method: m,
    headers: { "content-type": "application/json" },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, d: await r.json().catch(() => null) };
};
// Fast-forward straight past welcome / estate name / registration.
await j("POST", "/api/qa/seed", {
  estateName: "Eberbach Estate",
  prName: "Pat (PR)",
  prIsHeir: false,
  heirs: ["Alex", "Bea", "Chris"],
  phase: "intake",
});
let s = (await j("GET", "/api/state")).d;
const pr = s.participants.find((p) => p.isAdmin);
const tax = (await j("GET", "/api/taxonomy")).d;
const on = async (kind, label) => {
  const row = tax.find((t) => t.kind === kind && t.label === label);
  if (row) await j("PATCH", `/api/taxonomy/${row.id}`, { isEnabled: true, actorId: pr.id });
};
for (const r of ["Living Room", "Dining Room", "Kitchen", "Primary Bedroom", "Garage", "Attic"])
  await on("room", r);
for (const c of ["Furniture", "Art & Decor", "Jewelry", "Silver & China", "Tools", "Books"])
  await on("category", c);
const items = [
  ["Walnut dining table", "Dining Room", "Furniture", 1200],
  ["Set of eight dining chairs", "Dining Room", "Furniture", 900],
  ["Grandmother's silver service", "Dining Room", "Silver & China", 2400],
  ["Oil painting of the lake", "Living Room", "Art & Decor", 1500],
  ["Wingback reading chair", "Living Room", "Furniture", 400],
  ["Mantel clock", "Living Room", "Art & Decor", 650],
  ["Pearl necklace", "Primary Bedroom", "Jewelry", 1800],
  ["Cedar hope chest", "Primary Bedroom", "Furniture", 550],
  ["First-edition atlas collection", "Living Room", "Books", 700],
  ["Table saw", "Garage", "Tools", 480],
  ["Rolling tool chest", "Garage", "Tools", 320],
  ["Steamer trunk", "Attic", "Furniture", 260],
];
for (const [name, room, category, aiEstimatedValue] of items) {
  await j("POST", "/api/items", { participantId: pr.id, name, room, category, aiEstimatedValue });
}
await j("PATCH", "/api/session", { phase: "intake", actorId: pr.id });
const st = (await j("GET", "/api/state")).d;
console.log("participants", st.participants.length, "items", st.items.length, "phase", st.session.phase);
