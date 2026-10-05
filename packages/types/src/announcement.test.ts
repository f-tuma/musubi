import assert from "node:assert/strict";
import {
  announcementParagraphs,
  AnnouncementsResponseSchema,
  mintAnnouncementId,
  newestAnnouncementId,
  pendingAnnouncements,
  splitAnnouncementText,
} from "./announcement";

// --- mintAnnouncementId ---
assert.equal(mintAnnouncementId("2026-08-29", []), "2026-08-29");
assert.equal(mintAnnouncementId("2026-08-29", ["2026-08-29"]), "2026-08-29-2");
assert.equal(
  mintAnnouncementId("2026-08-29", ["2026-08-29", "2026-08-29-2"]),
  "2026-08-29-3",
);
// Cizí datum v seznamu nic neblokuje.
assert.equal(mintAnnouncementId("2026-08-29", ["2026-08-28"]), "2026-08-29");

// Fill neither gaps nor the bare date if they sort behind the read marker.
assert.equal(mintAnnouncementId("2026-08-29", ["2026-08-29-4"]), "2026-08-29-5");
assert.equal(
  mintAnnouncementId("2026-08-29", ["2026-08-29", "2026-08-29-2", "2026-08-29-4"]),
  "2026-08-29-5",
);
for (const suffix of ["9", "99", "99999999999999999999", "09"]) {
  const previous = `2026-08-29-${suffix}`;
  const next = mintAnnouncementId("2026-08-29", [previous, "2026-08-30-99"]);
  assert.ok(next > previous, "A new same-day message must pass the existing lexical read marker");
  assert.match(next, /^2026-08-29-\d+$/);
}
assert.equal(
  mintAnnouncementId("2026-08-29", ["2026-08-29-9", "2026-08-29-10"]),
  "2026-08-29-90",
);
assert.equal(mintAnnouncementId("2026-08-29", ["2026-08-29-invalid"]), "2026-08-29");

// --- splitAnnouncementText ---
assert.deepEqual(splitAnnouncementText("just words"), [
  { type: "text", value: "just words" },
]);

assert.deepEqual(
  splitAnnouncementText("see https://musubi.pro today"),
  [
    { type: "text", value: "see " },
    { type: "link", url: "https://musubi.pro", value: "https://musubi.pro" },
    { type: "text", value: " today" },
  ],
);

// Tečka na konci věty není součástí odkazu.
assert.deepEqual(
  splitAnnouncementText("go to https://musubi.pro."),
  [
    { type: "text", value: "go to " },
    { type: "link", url: "https://musubi.pro", value: "https://musubi.pro" },
    { type: "text", value: "." },
  ],
);

// Ani uzavírací závorka.
assert.deepEqual(
  splitAnnouncementText("(https://musubi.pro)"),
  [
    { type: "text", value: "(" },
    { type: "link", url: "https://musubi.pro", value: "https://musubi.pro" },
    { type: "text", value: ")" },
  ],
);

// Odkaz na začátku i na konci, bez prázdných text úseků okolo.
assert.deepEqual(splitAnnouncementText("https://musubi.pro"), [
  { type: "link", url: "https://musubi.pro", value: "https://musubi.pro" },
]);

// Bezpečnostní hranice: obsah píše majitel serveru, ale nic než http(s) se
// nesmí stát klikatelným — javascript: URL v modalu je spouštěč skriptu.
assert.deepEqual(splitAnnouncementText("javascript:alert(1)"), [
  { type: "text", value: "javascript:alert(1)" },
]);
assert.deepEqual(splitAnnouncementText("data:text/html,<b>x</b>"), [
  { type: "text", value: "data:text/html,<b>x</b>" },
]);

// --- announcementParagraphs ---
assert.deepEqual(announcementParagraphs("first\n\nsecond"), [
  [{ type: "text", value: "first" }],
  [{ type: "text", value: "second" }],
]);
// Jeden zlom řádku odstavec netvoří.
assert.deepEqual(announcementParagraphs("one\ntwo"), [
  [{ type: "text", value: "one\ntwo" }],
]);
// Tři a víc prázdných řádků nedělá prázdné odstavce.
assert.deepEqual(announcementParagraphs("a\n\n\n\nb"), [
  [{ type: "text", value: "a" }],
  [{ type: "text", value: "b" }],
]);

// --- pendingAnnouncements ---
const all = [
  { id: "2026-08-01", title: "old", body: "x", minVersion: null },
  { id: "2026-08-20", title: "gated", body: "x", minVersion: "0.1.7" },
  { id: "2026-08-10", title: "open", body: "x", minVersion: "0.1.6" },
];

// Klient na 0.1.6 nedostane zprávu určenou pro 0.1.7.
assert.deepEqual(
  pendingAnnouncements(all, "0.1.6").map((a) => a.id),
  ["2026-08-10", "2026-08-01"],
);

// Po aktualizaci na 0.1.7 ji dostane, a jako nejnovější.
assert.deepEqual(
  pendingAnnouncements(all, "0.1.7").map((a) => a.id),
  ["2026-08-20", "2026-08-10", "2026-08-01"],
);

// Číselné porovnání: 0.1.10 je novější než 0.1.9, jako řetězce by to bylo naopak.
assert.deepEqual(
  pendingAnnouncements(
    [{ id: "2026-08-01", title: "t", body: "x", minVersion: "0.1.10" }],
    "0.1.9",
  ),
  [],
);
assert.equal(
  pendingAnnouncements(
    [{ id: "2026-08-01", title: "t", body: "x", minVersion: "0.1.10" }],
    "0.1.10",
  ).length,
  1,
);

// --- AnnouncementsResponseSchema ---
// `markTo` musí schématem projít: bez něj by ho mobil (který parsuje přes
// readWire) zahodil a první pohled by se opakoval při každém startu.
assert.equal(
  AnnouncementsResponseSchema.parse({
    announcements: [],
    isAdmin: false,
    markTo: "2026-08-29",
  }).markTo,
  "2026-08-29",
);
// A chybět smí — běžná odpověď ho neposílá.
assert.equal(
  AnnouncementsResponseSchema.parse({ announcements: [], isAdmin: false })
    .markTo,
  undefined,
);

// --- newestAnnouncementId ---
assert.equal(newestAnnouncementId(all), "2026-08-20");
assert.equal(newestAnnouncementId([]), undefined);
// Přípona téhož dne se řadí za holé datum.
assert.equal(
  newestAnnouncementId([
    { id: "2026-08-29", title: "t", body: "x", minVersion: null },
    { id: "2026-08-29-2", title: "t", body: "x", minVersion: null },
  ]),
  "2026-08-29-2",
);

console.log("announcement tests passed");
