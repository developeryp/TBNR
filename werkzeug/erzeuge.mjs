/**
 * Erzeugt die Katalog-Website aus Firestore.
 *
 * Liest dasselbe Dokument, aus dem auch die iOS- und die Android-App lesen,
 * und schreibt daraus fertige HTML-Dateien:
 *
 *     t/<nummer>/index.html   eine Seite je Tatbestand
 *     katalog/index.html      die Suche
 *     katalog/daten.json      Suchindex fuer den Browser
 *     sitemap.xml, robots.txt
 *
 * Warum fertige Dateien statt einer Suche auf dem Server: GitHub Pages
 * liefert nur Statisches aus. Jede Tatbestandsnummer bekommt so ihre eigene
 * Adresse, die Google lesen kann — genau darum geht es bei dieser Website.
 * Die Suche selbst laeuft dann im Browser ueber einen kleinen Index.
 *
 * Aufruf:  node werkzeug/erzeuge.mjs
 * Taeglich automatisch ueber .github/workflows/katalog.yml
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROJEKT = "tatbestandskatalog-60d4c";
const DOKUMENT =
  `https://firestore.googleapis.com/v1/projects/${PROJEKT}` +
  "/databases/(default)/documents/Einstellungen/TB/Sonstiges/Sonstiges";

/** Oeffentliche Adresse. Nur fuer Sitemap und canonical — alle Verweise
 *  innerhalb der Seiten sind relativ und ueberstehen einen Domainwechsel. */
const BASIS = process.env.BASIS || "https://developeryp.github.io/TBNR";

const BLAU = "#32ADE6";

/** Rechtsgrundlage aus der ersten Ziffer — wie FilterKategorie.vonTbnr. */
const BEREICHE = [
  { kennung: "stvo", titel: "StVO", ziffer: "1" },
  { kennung: "fev", titel: "FeV", ziffer: "2" },
  { kennung: "stvzo", titel: "StVZO", ziffer: "3" },
  { kennung: "ekfv", titel: "eKFV", ziffer: "6" },
  { kennung: "fzv", titel: "FZV", ziffer: "8" },
];

// ------------------------------------------------------------------ Daten

async function holeAusFirestore() {
  const antwort = await fetch(DOKUMENT);
  if (!antwort.ok) throw new Error(`Firestore meldet ${antwort.status}`);
  const doc = await antwort.json();

  const werte = doc?.fields?.TatbestandeLang?.arrayValue?.values;
  if (!Array.isArray(werte) || werte.length < 100) {
    throw new Error("Katalog aus Firestore unbrauchbar");
  }

  const roh = doc?.fields?.Synonyme?.mapValue?.fields || {};
  const synonyme = Object.entries(roh).map(([k, v]) => [k, v.stringValue || ""]);

  return { zeilen: werte.map((w) => w.stringValue ?? ""), synonyme };
}

/**
 * Zerlegt eine Katalogzeile im Format der Apps.
 * 0 Nummer + Text, 1 Paragraphen, 2 Bussgeld, 3 Punkte, 4 Fahrverbot,
 * 5 Verstossart, 6 Konkretisierungsindikator, 7 Fahrzeugart.
 */
function zerlege(eintrag) {
  const zeilen = eintrag.split("\n");
  if (zeilen.length < 5) return null;
  const kopf = zeilen[0].trim();
  const trenner = kopf.indexOf(" ");
  if (trenner < 0) return null;

  return {
    nummer: kopf.slice(0, trenner),
    text: kopf.slice(trenner + 1).trim(),
    paragraphen: (zeilen[1] || "").trim(),
    bussgeld: (zeilen[2] || "").trim(),
    punkte: (zeilen[3] || "").trim(),
    fahrverbot: (zeilen[4] || "").trim(),
    verstossart: (zeilen[5] || "").trim(),
    fahrzeugart: (zeilen[7] || "").trim(),
  };
}

// --------------------------------------------------------------- Bausteine

function schuetze(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STIL = `
  :root { --blau:${BLAU}; --grund:#fff; --flaeche:#f2f3f5; --schrift:#11181c;
          --gedaempft:#5f6b73; --rand:#e3e5e8; }
  @media (prefers-color-scheme: dark) {
    :root { --grund:#0f1416; --flaeche:#1b2327; --schrift:#e9edef;
            --gedaempft:#9aa4ab; --rand:#2b3438; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--grund); color:var(--schrift);
    font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust:100%; }
  header { background:var(--blau); padding:14px 20px; }
  header a { color:#fff; text-decoration:none; font-weight:700; font-size:19px; }
  main { max-width:760px; margin:0 auto; padding:20px 16px 60px; }
  form { display:flex; gap:8px; margin:0 0 14px; }
  input[type=search] { flex:1; min-width:0; padding:12px 15px; font:inherit;
    border:1px solid var(--rand); border-radius:10px;
    background:var(--flaeche); color:var(--schrift); }
  button { padding:12px 20px; font:inherit; font-weight:600; border:0;
    border-radius:10px; background:var(--blau); color:#fff; cursor:pointer; }
  .treffer { display:block; padding:14px 0; border-bottom:1px solid var(--rand);
    text-decoration:none; color:inherit; }
  .treffer:hover { background:var(--flaeche); }
  .nr { color:var(--blau); font-weight:700; font-variant-numeric:tabular-nums; }
  .text { margin:3px 0 7px; }
  .marken { display:flex; flex-wrap:wrap; gap:6px; }
  .marke { font-size:13px; padding:3px 9px; border-radius:20px;
    background:var(--flaeche); color:var(--gedaempft); white-space:nowrap;
    text-decoration:none; }
  .marke.stark { background:var(--blau); color:#fff; }
  .marke.a { background:#d93025; color:#fff; }
  .marke.b { background:#b26a00; color:#fff; }
  h1 { font-size:26px; line-height:1.25; margin:0 0 6px; }
  h2 { font-size:17px; margin:28px 0 10px; }
  .zahlen { display:flex; flex-wrap:wrap; gap:10px; margin:18px 0; }
  .zahl { flex:1 1 110px; background:var(--flaeche); border-radius:12px; padding:12px 14px; }
  .zahl b { display:block; font-size:22px; }
  .zahl span { font-size:13px; color:var(--gedaempft); }
  .feld { background:var(--flaeche); border-radius:12px; padding:12px 14px; margin:10px 0; }
  .feld span { font-size:13px; color:var(--gedaempft); display:block; margin-bottom:2px; }
  .hinweis { color:var(--gedaempft); font-size:14px; }
  .aktuell { background:var(--flaeche); border-left:3px solid var(--blau); padding-left:11px; }
  footer { max-width:760px; margin:0 auto; padding:0 16px 40px;
    color:var(--gedaempft); font-size:13px; }
  footer a { color:var(--blau); }
`;

function geruest({ titel, beschreibung, inhalt, pfad, hoch, skript = "" }) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${schuetze(titel)}</title>
<meta name="description" content="${schuetze(beschreibung)}">
<link rel="canonical" href="${BASIS}${pfad}">
<link rel="stylesheet" href="${hoch}stil.css">
</head>
<body>
<header><a href="${hoch}katalog/">Tatbestandskatalog</a></header>
<main>${inhalt}</main>
<footer>
  <p>Alle Angaben ohne Gewähr. Maßgeblich ist der amtliche Bußgeldkatalog.</p>
  <p>Unterwegs nachschlagen, Tatbestände merken und eigene Notizen anlegen:
     <a href="https://apps.apple.com/de/app/tatbestandskatalog/id6473509923">iPhone</a> ·
     <a href="https://play.google.com/store/apps/details?id=com.yp.tatbestandskatalog">Android</a></p>
  <p><a href="${hoch}index.html">Rechtliche Informationen</a></p>
</footer>${skript}
</body>
</html>`;
}

function marken(e, stark = false) {
  const t = [];
  if (e.bussgeld) t.push(`<span class="marke${stark ? " stark" : ""}">${schuetze(e.bussgeld)} €</span>`);
  if (e.punkte && e.punkte !== "0") {
    t.push(`<span class="marke">${schuetze(e.punkte)} ${e.punkte === "1" ? "Punkt" : "Punkte"}</span>`);
  }
  if (e.fahrverbot && e.fahrverbot !== "0") {
    t.push(`<span class="marke">Fahrverbot ${schuetze(e.fahrverbot.replace(/\s*M$/, " Monat(e)"))}</span>`);
  }
  if (e.verstossart === "A") t.push(`<span class="marke a">A-Verstoß</span>`);
  if (e.verstossart === "B") t.push(`<span class="marke b">B-Verstoß</span>`);
  if (e.fahrzeugart) t.push(`<span class="marke">${schuetze(e.fahrzeugart)}</span>`);
  return `<div class="marken">${t.join("")}</div>`;
}

/** Nachbarstufen desselben Sachverhalts: behindert, gefaehrdet, Unfall. */
function stufen(daten, eintrag) {
  const nachsatz = /\s*(und behinderten.*|und gefährdeten.*|Es kam zum Unfall\.?)$/i;
  const rumpf = (t) => t.replace(nachsatz, "").replace(/[.\s]+$/, "").toLowerCase();
  const kern = rumpf(eintrag.text);
  if (kern.length < 25) return [];
  return daten
    .filter((e) => rumpf(e.text) === kern)
    .sort((a, b) => Number(a.bussgeld || 0) - Number(b.bussgeld || 0));
}

function tatbestandSeite(e, verwandte) {
  const hoch = "../../";
  const zahl = (wert, beschriftung) =>
    `<div class="zahl"><b>${schuetze(wert)}</b><span>${beschriftung}</span></div>`;

  const probezeit = e.verstossart === "A"
    ? `<div class="feld"><span>Probezeit</span>Schwerwiegender Verstoß (A). Ein A-Verstoß
         führt zur Verlängerung der Probezeit auf vier Jahre und zur Anordnung eines
         Aufbauseminars.</div>`
    : e.verstossart === "B"
    ? `<div class="feld"><span>Probezeit</span>Weniger schwerwiegender Verstoß (B). Erst
         zwei B-Verstöße haben dieselbe Folge wie ein A-Verstoß.</div>`
    : "";

  const leiter = verwandte.length > 1
    ? `<h2>Je nach Folge</h2>` + verwandte.map((v) => v.nummer === e.nummer
        ? `<div class="treffer aktuell"><span class="nr">${schuetze(v.nummer)}</span>
             <div class="text">${schuetze(v.text)}</div>${marken(v, true)}</div>`
        : `<a class="treffer" href="../${schuetze(v.nummer)}/">
             <span class="nr">${schuetze(v.nummer)}</span>
             <div class="text">${schuetze(v.text)}</div>${marken(v)}</a>`).join("")
    : "";

  const kurz = e.text.length > 90 ? e.text.slice(0, 87) + "…" : e.text;
  const zahlen = [
    e.bussgeld ? `${e.bussgeld} €` : null,
    e.punkte && e.punkte !== "0" ? `${e.punkte} ${e.punkte === "1" ? "Punkt" : "Punkte"}` : null,
    e.fahrverbot && e.fahrverbot !== "0" ? "Fahrverbot" : null,
  ].filter(Boolean).join(", ");

  return geruest({
    // "Tatbestandsnummer" steht bewusst im Titel: Genau danach wird gesucht,
    // und bei dieser Wortkombination gibt es kaum Konkurrenz.
    titel: `Tatbestandsnummer ${e.nummer} – ${kurz}${zahlen ? " · " + zahlen : ""}`,
    beschreibung: `Tatbestandsnummer ${e.nummer}: ${kurz} ` +
      `${e.bussgeld ? e.bussgeld + " Euro" : "kein Bußgeld"}` +
      `${e.punkte && e.punkte !== "0"
          ? ", " + e.punkte + (e.punkte === "1" ? " Punkt" : " Punkte") : ""}.`,
    pfad: `/t/${e.nummer}/`,
    hoch,
    inhalt: `
      <form action="${hoch}katalog/" method="get">
        <input type="search" name="q" placeholder="Anderen Tatbestand suchen …">
        <button type="submit">Suchen</button>
      </form>
      <p class="nr" style="font-size:19px">${schuetze(e.nummer)}</p>
      <h1>${schuetze(e.text)}</h1>
      <div class="zahlen">
        ${zahl(e.bussgeld ? e.bussgeld + " €" : "–", "Bußgeld")}
        ${zahl(e.punkte || "0", "Punkte")}
        ${zahl(e.fahrverbot && e.fahrverbot !== "0"
               ? e.fahrverbot.replace(/\s*M$/, " Monate") : "–", "Fahrverbot")}
      </div>
      ${e.paragraphen ? `<div class="feld"><span>Rechtsgrundlage</span>${schuetze(e.paragraphen)}</div>` : ""}
      ${e.fahrzeugart ? `<div class="feld"><span>Fahrzeugart</span>${schuetze(e.fahrzeugart)}</div>` : ""}
      ${probezeit}
      ${leiter}`,
  });
}

/**
 * Die Suchseite.
 *
 * Sucht im Browser ueber einen kleinen Index — dieselbe Regel wie in den
 * Apps: alle Woerter in beliebiger Reihenfolge, durchsucht werden Nummer,
 * Text und Fahrzeugart, sortiert nach Nummer. Bei null Treffern dieselben
 * Synonym-Vorschlaege aus Firestore.
 */
function sucheSeite(synonyme) {
  const skript = `
<script>
(function () {
  var daten = [], synonyme = ${JSON.stringify(synonyme)};
  var feld = document.getElementById("q"), liste = document.getElementById("liste");
  var bereich = "";

  function entschaerfe(t) {
    return (t || "").toLowerCase().normalize("NFD")
      .replace(/[\\u0300-\\u036f]/g, "").replace(/[.,]/g, "");
  }
  function marken(e) {
    var m = [];
    if (e.g) m.push('<span class="marke">' + e.g + ' €</span>');
    if (e.p && e.p !== "0") m.push('<span class="marke">' + e.p + (e.p === "1" ? " Punkt" : " Punkte") + '</span>');
    if (e.v) m.push('<span class="marke ' + e.v.toLowerCase() + '">' + e.v + '-Verstoß</span>');
    if (e.f) m.push('<span class="marke">' + e.f + '</span>');
    return '<div class="marken">' + m.join("") + '</div>';
  }
  function zeichne() {
    var anfrage = feld.value.trim();
    if (!anfrage) { liste.innerHTML = ""; return; }
    var worte = entschaerfe(anfrage).split(/\\s+/).filter(Boolean);
    var grund = bereich ? daten.filter(function (e) { return e.n[0] === bereich; }) : daten;
    var treffer = grund.filter(function (e) {
      return worte.every(function (w) { return e.s.indexOf(w) >= 0; });
    });
    if (!treffer.length) {
      var tipps = [], tief = anfrage.toLowerCase();
      for (var k in synonyme) {
        var s = k.toLowerCase();
        if (tief.indexOf(s) >= 0 || s.indexOf(tief) >= 0) tipps.push(synonyme[k]);
      }
      liste.innerHTML = '<h1>Keine Treffer</h1><p class="hinweis">Der Katalog ist in '
        + 'Amtsdeutsch verfasst und schreibt etwa „Höchstgeschwindigkeit" statt „geblitzt".</p>'
        + (tipps.length ? '<h2>Meinten Sie</h2><div class="marken">' + tipps.slice(0,6).map(
            function (t) { return '<a class="marke stark" href="?q=' + encodeURIComponent(t) + '">' + t + '</a>'; }
          ).join("") + '</div>' : "");
      return;
    }
    liste.innerHTML = '<h1>' + treffer.length + ' Treffer</h1>'
      + treffer.slice(0, 200).map(function (e) {
          return '<a class="treffer" href="../t/' + e.n + '/"><span class="nr">' + e.n
            + '</span><div class="text">' + e.t + '</div>' + marken(e) + '</a>';
        }).join("");
  }
  feld.addEventListener("input", zeichne);
  document.getElementById("suche").addEventListener("submit", function (ev) {
    ev.preventDefault(); zeichne();
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-bereich]"), function (a) {
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      bereich = a.getAttribute("data-bereich");
      Array.prototype.forEach.call(document.querySelectorAll("[data-bereich]"), function (x) {
        x.className = "marke" + (x === a ? " stark" : "");
      });
      zeichne();
    });
  });
  fetch("daten.json").then(function (r) { return r.json(); }).then(function (d) {
    daten = d;
    var start = new URLSearchParams(location.search).get("q");
    if (start) { feld.value = start; }
    zeichne();
  });
})();
</script>`;

  const leiste = `<div class="marken" style="margin:0 0 20px">
      <a class="marke stark" href="#" data-bereich="">Alle</a>
      ${BEREICHE.map((b) => `<a class="marke" href="#" data-bereich="${b.ziffer}">${b.titel}</a>`).join("")}
    </div>`;

  return geruest({
    titel: "Bußgeldkatalog durchsuchen – Tatbestandskatalog",
    beschreibung: "Alle Tatbestände des amtlichen Bußgeldkatalogs durchsuchen — "
      + "mit Tatbestandsnummer, Bußgeld, Punkten und Fahrverbot.",
    pfad: "/katalog/",
    hoch: "../",
    skript,
    inhalt: `
      <form id="suche">
        <input type="search" id="q" name="q" placeholder="Tatbestand oder Nummer suchen …" autofocus>
        <button type="submit">Suchen</button>
      </form>
      ${leiste}
      <div id="liste"></div>
      <noscript><p class="hinweis">Für die Suche wird JavaScript benötigt. Einzelne
        Tatbestände sind auch ohne erreichbar, etwa unter <code>/t/112665/</code>.</p></noscript>`,
  });
}

// ------------------------------------------------------------------ Lauf

// fileURLToPath statt .pathname: Letzteres liefert die Adresse URL-kodiert,
// und in Ordnernamen mit Leerzeichen entstuenden daraus "%20"-Pfade.
const wurzel = fileURLToPath(new URL("..", import.meta.url));

console.log("Hole Katalog aus Firestore …");
const { zeilen, synonyme } = await holeAusFirestore();
const daten = zeilen.map(zerlege).filter((e) => e && e.nummer && e.text);
console.log(`  ${daten.length} Tatbestände, ${synonyme.length} Synonyme`);

// Alte Seiten weg, damit entfernte Tatbestaende nicht stehenbleiben.
if (existsSync(wurzel + "t")) await rm(wurzel + "t", { recursive: true });
await mkdir(wurzel + "katalog", { recursive: true });

for (const e of daten) {
  await mkdir(`${wurzel}t/${e.nummer}`, { recursive: true });
  await writeFile(`${wurzel}t/${e.nummer}/index.html`, tatbestandSeite(e, stufen(daten, e)));
}
console.log(`  ${daten.length} Seiten geschrieben`);

// Suchindex: nur was gesucht oder angezeigt wird, die Paragraphen bleiben draussen.
const index = daten.map((e) => ({
  n: e.nummer, t: e.text, g: e.bussgeld, p: e.punkte,
  v: e.verstossart, f: e.fahrzeugart,
  s: (e.nummer + " " + e.text + " " + e.fahrzeugart)
      .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.,]/g, ""),
}));
await writeFile(wurzel + "katalog/daten.json", JSON.stringify(index));
await writeFile(wurzel + "katalog/index.html", sucheSeite(Object.fromEntries(synonyme)));
await writeFile(wurzel + "stil.css", STIL);

await writeFile(wurzel + "sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
  + `<url><loc>${BASIS}/katalog/</loc></url>`
  + daten.map((e) => `<url><loc>${BASIS}/t/${e.nummer}/</loc></url>`).join("")
  + `</urlset>\n`);

// Der Katalog soll gefunden werden. Die rechtlichen Seiten tragen ihr eigenes
// noindex — dafuer muessen sie aber lesbar sein, deshalb kein Disallow.
await writeFile(wurzel + "robots.txt",
  `User-agent: *\nAllow: /\nSitemap: ${BASIS}/sitemap.xml\n`);

console.log("Fertig.");
