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

import { mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const PROJEKT = "tatbestandskatalog-60d4c";
const DOKUMENT =
  `https://firestore.googleapis.com/v1/projects/${PROJEKT}` +
  "/databases/(default)/documents/Einstellungen/TB/Sonstiges/Sonstiges";

/** Die Verkehrszeichen liegen in einem eigenen Dokument. */
const DOKUMENT_VZ =
  `https://firestore.googleapis.com/v1/projects/${PROJEKT}` +
  "/databases/(default)/documents/Einstellungen/VZ";

/** Oeffentliche Adresse. Nur fuer Sitemap und canonical — alle Verweise
 *  innerhalb der Seiten sind relativ und ueberstehen einen Domainwechsel. */
const BASIS = process.env.BASIS || "https://tbnr.app";

const wurzelPfad = fileURLToPath(new URL("..", import.meta.url));

const BLAU = "#32ADE6";


/** Pfadstueck vor der Nummer. Ausgeschrieben, weil Google das Stichwort in
 *  der Adresse mitliest — "/tatbestand/112665/" schlaegt "/t/112665/". */
const PFAD = "tatbestand";
const PFAD_VZ = "verkehrszeichen";

/** Kennungen der beiden Apps — fuer Deeplinks und Banner. */
const APPLE_ID = "6473509923";
const ANDROID_PAKET = "com.yp.tatbestandskatalog";
const APPLE_LINK = `https://apps.apple.com/de/app/tatbestandskatalog/id${APPLE_ID}`;
const PLAY_LINK = `https://play.google.com/store/apps/details?id=${ANDROID_PAKET}`;

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

/**
 * Verkehrszeichen laden.
 *
 * Format wie in der App: "101-10 Flugbetrieb - Aufstellung rechts" — bis zum
 * ersten Leerzeichen die Nummer, danach die Beschreibung. Erst Firestore
 * (dasselbe Dokument wie die Apps), sonst die mitgelieferte Liste.
 */
async function holeZeichen() {
  let lang, quelle = "Firestore";
  try {
    const antwort = await fetch(DOKUMENT_VZ);
    if (!antwort.ok) throw new Error(String(antwort.status));
    const doc = await antwort.json();
    lang = doc?.fields?.VZBeschreibungLangOnline?.arrayValue?.values?.map((v) => v.stringValue);
    if (!lang || lang.length < 50) throw new Error("Liste unbrauchbar");
  } catch (fehler) {
    console.log("  Zeichen aus Firestore nicht verfuegbar:", fehler.message);
    lang = JSON.parse(await readFile(wurzelPfad + "daten/vz_lang.json", "utf8"));
    quelle = "mitgeliefert";
  }

  const zeichen = lang
    .map((z) => (z || "").trim())
    .filter(Boolean)
    .map((z) => {
      const trenner = z.indexOf(" ");
      if (trenner <= 0) return null;
      return { nummer: z.slice(0, trenner), beschreibung: z.slice(trenner + 1).trim() };
    })
    .filter(Boolean);

  return { zeichen, quelle };
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
  header { background:var(--blau); padding:12px 18px; display:flex;
    align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
  header a { color:#fff; text-decoration:none; }
  .marke-wort { font-weight:700; font-size:19px; }
  header nav { display:flex; gap:8px; }
  header nav a { font-size:14px; font-weight:600; padding:6px 12px;
    border-radius:20px; background:rgba(255,255,255,.18); white-space:nowrap; }
  header nav a:hover { background:rgba(255,255,255,.3); }
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
  /* Die Tatbestandsnummer ist das, wonach gesucht und was abgeschrieben
     wird — sie steht deshalb groesser als der Sachverhalt darunter. */
  .grossenummer { color:var(--blau); font-weight:800; font-size:34px;
    font-variant-numeric:tabular-nums; letter-spacing:-.5px; margin:0 0 2px; }
  .zeichenbild { max-width:240px; width:100%; height:auto; }
  .zeichengitter { display:grid; gap:10px;
    grid-template-columns:repeat(auto-fill,minmax(132px,1fr)); }
  .zeichenkachel { display:flex; flex-direction:column; align-items:center;
    gap:6px; padding:14px 10px; border-radius:14px; background:var(--flaeche);
    text-decoration:none; color:inherit; text-align:center; }
  .zeichenkachel:hover { outline:2px solid var(--blau); }
  .zeichenkachel img { width:62px; height:62px; object-fit:contain; }
  /* Zwei Zeilen, danach drei Puenktchen — vorher wurde hart nach 40 Zeichen
     abgeschnitten, mitten im Wort und ohne Hinweis darauf. */
  .zeichenkachel .bez { font-size:12px; color:var(--gedaempft); line-height:1.3;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
    overflow:hidden; }
  /* Gleich hohe Kacheln, damit das Gitter ruhig wirkt. */
  .zeichenkachel { justify-content:flex-start; }
  .einstiege { display:grid; gap:12px; margin:26px auto 0; max-width:620px;
    grid-template-columns:repeat(auto-fit,minmax(248px,1fr)); }
  .einstiege a { display:flex; align-items:center; gap:13px; text-align:left;
    background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.28);
    color:#fff; text-decoration:none; padding:14px 16px; border-radius:16px;
    transition:transform .12s, background .12s; }
  .einstiege a:hover { background:rgba(255,255,255,.26); transform:translateY(-2px); }
  /* Kein Hintergrund und keine Rundung: Die Verkehrszeichen sind freigestellt,
     ein weisses Kaestchen dahinter saehe nach Fehler aus. Das App-Symbol
     bringt seine runden Ecken selbst mit. */
  .einstiege img { width:46px; height:46px; flex:0 0 auto; object-fit:contain; }
  .einstiege span { display:flex; flex-direction:column; font-size:13px;
    line-height:1.35; opacity:.9; }
  .einstiege b { font-size:17px; opacity:1; margin-bottom:1px; }
  .zweispalten { display:grid; gap:30px; align-items:start;
    grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); }
  .zweispalten h2 { margin-top:0; }
  .zweispalten .karten { grid-template-columns:1fr; }
  .zweispalten .zeichengitter { grid-template-columns:repeat(auto-fill,minmax(104px,1fr)); }
  /* Startseite */
  .buehne { background:linear-gradient(160deg,#32ADE6,#2563eb); color:#fff;
    padding:52px 20px 44px; text-align:center; }
  /* Mitwachsend, damit der lange Name auch auf schmalen Geraeten passt. */
  .buehne h1 { font-size:clamp(27px,8vw,42px); margin:0 0 10px; letter-spacing:-.5px;
    overflow-wrap:anywhere; }
  .buehne p { margin:0 auto; max-width:460px; opacity:.92; font-size:17px; }
  .buehne form { max-width:460px; margin:26px auto 0; }
  .buehne input { background:#fff; color:#11181c; border:0; }
  .buehne button { background:#11181c; }
  .karten { display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); }
  .karte { display:block; background:var(--flaeche); border-radius:14px;
    padding:14px 16px; text-decoration:none; color:inherit; }
  .karte:hover { outline:2px solid var(--blau); }
  .apps { display:flex; gap:18px; align-items:center; flex-wrap:wrap;
    background:var(--flaeche); border-radius:16px; padding:20px; margin-top:14px; }
  .apps img { width:76px; height:76px; border-radius:17px; }
  .appknopf { display:inline-block; padding:11px 18px; border-radius:10px;
    background:var(--blau); color:#fff; text-decoration:none; font-weight:600; }
  footer { max-width:760px; margin:0 auto; padding:0 16px 40px;
    color:var(--gedaempft); font-size:13px; }
  footer a { color:var(--blau); }
`;

/** Haengt an der Stylesheet-Adresse. Browser halten CSS zehn Minuten lang
 *  fest; ohne diese Kennung sieht man eine Aenderung erst danach.
 *
 *  Abgeleitet aus dem Inhalt, nicht aus der Uhrzeit: Sonst bekaeme jede
 *  Seite bei jedem Lauf eine neue Adresse, und die taegliche Action wuerde
 *  alle 3836 Dateien einchecken, obwohl sich nichts geaendert hat. */
const STILVERSION = createHash("sha1").update(STIL).digest("hex").slice(0, 8);

function geruest({ titel, beschreibung, inhalt, pfad, hoch, skript = "", banner = "" }) {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${schuetze(titel)}</title>
<meta name="description" content="${schuetze(beschreibung)}">
<link rel="canonical" href="${BASIS}${pfad}">
<link rel="icon" href="${hoch}bilder/icon-32.png" sizes="32x32">
<link rel="icon" href="${hoch}bilder/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="${hoch}bilder/icon-180.png">
<meta name="theme-color" content="${BLAU}">
<link rel="stylesheet" href="${hoch}stil.css?v=${STILVERSION}">${banner}
</head>
<body>
<header>
  <a class="marke-wort" href="${hoch}">Tatbestandskatalog</a>
  <nav>
    <a href="${hoch}katalog/">Tatbestände</a>
    <a href="${hoch}${PFAD_VZ}/">Verkehrszeichen</a>
  </nav>
</header>
<main>${inhalt}</main>
<footer>
  <p>Alle Angaben ohne Gewähr. Maßgeblich ist der amtliche Bußgeldkatalog.</p>
  <p>Unterwegs nachschlagen, Tatbestände merken und eigene Notizen anlegen:
     <a href="https://apps.apple.com/de/app/tatbestandskatalog/id6473509923">iPhone</a> ·
     <a href="https://play.google.com/store/apps/details?id=com.yp.tatbestandskatalog">Android</a></p>
  <p><a href="${hoch}">Startseite</a> ·
     <a href="${hoch}Datenschutzerkl%C3%A4rung.html">Datenschutzerklärung</a> ·
     <a href="${hoch}Nutzungsbedingungen.html">Nutzungsbedingungen</a></p>
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
    ? `<h2>Vorschläge</h2>` + verwandte.map((v) => v.nummer === e.nummer
        ? `<div class="treffer aktuell"><span class="nr">${schuetze(v.nummer)}</span>
             <div class="text">${schuetze(v.text)}</div>${marken(v, true)}</div>`
        : `<a class="treffer" href="../${schuetze(v.nummer)}/">
             <span class="nr">${schuetze(v.nummer)}</span>
             <div class="text">${schuetze(v.text)}</div>${marken(v)}</a>`).join("")
    : "";

  // Beide Apps lesen die Nummer aus dem Host der Adresse (SceneDelegate
  // unter iOS, intent.data.host unter Android) — "tbnr://112665" oeffnet den
  // Tatbestand also direkt. Ist die App nicht da, passiert nichts; darum
  // stehen die Store-Verweise weiterhin in der Fusszeile.
  // iOS loest das ueber das Smart App Banner oben im Safari — installiert
  // heisst "Öffnen", sonst "Anzeigen". Android kennt so etwas nicht, dort
  // tut es eine intent-Adresse: Ist die App da, geht sie auf, sonst
  // uebernimmt browser_fallback_url und schickt in den Play Store.
  const androidLink = `intent://${e.nummer}#Intent;scheme=tbnr;package=${ANDROID_PAKET};`
    + `S.browser_fallback_url=${encodeURIComponent(PLAY_LINK)};end`;

  const appKnopf = `<p style="margin:18px 0 0">
      <a href="tbnr://${e.nummer}" class="appknopf" id="appknopf">In der App öffnen</a>
    </p>
    <script>
      // Nur Android braucht eine andere Adresse. Auf dem Rechner bleibt der
      // Knopf stehen und tut nichts — das ist dort auch die richtige Antwort.
      if (/Android/i.test(navigator.userAgent)) {
        document.getElementById("appknopf").href = ${JSON.stringify(androidLink)};
      }
    </script>`;

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
    pfad: `/${PFAD}/${e.nummer}/`,
    hoch,
    banner: `\n<meta name="apple-itunes-app" content="app-id=${APPLE_ID}, app-argument=tbnr://${e.nummer}">`,
    inhalt: `
      <form action="${hoch}katalog/" method="get">
        <input type="search" name="q" placeholder="Anderen Tatbestand suchen …">
        <button type="submit">Suchen</button>
      </form>
      <p class="grossenummer">${schuetze(e.nummer)}</p>
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
      ${appKnopf}
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
  var daten = [], synonyme = ${JSON.stringify(synonyme)}, PFADJS = ${JSON.stringify(PFAD)};
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
          return '<a class="treffer" href="../' + PFADJS + '/' + e.n + '/"><span class="nr">' + e.n
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
      <p style="margin:-6px 0 18px"><a class="marke" style="padding:6px 12px"
         href="../${PFAD_VZ}/">Oder nach Verkehrszeichen suchen →</a></p>
      <div id="liste"></div>
      <noscript><p class="hinweis">Für die Suche wird JavaScript benötigt. Einzelne
        Tatbestände sind auch ohne erreichbar, etwa unter <code>/${PFAD}/112665/</code>.</p></noscript>`,
  });
}

/** Ein Verkehrszeichen gross, dazu die Tatbestaende dazu. */
function zeichenSeite(z, passende, hatBild) {
  const hoch = "../../";
  const bild = hatBild
    ? `<p style="text-align:center;margin:8px 0 20px">
         <img src="${hoch}bilder/vz/${encodeURIComponent(z.nummer)}.png"
              alt="Verkehrszeichen ${schuetze(z.nummer)}" class="zeichenbild"></p>`
    : "";

  const liste = passende.length
    ? `<h2>${passende.length} ${passende.length === 1 ? "Tatbestand" : "Tatbestände"} dazu</h2>`
      + passende.map((e) => `<a class="treffer" href="${hoch}${PFAD}/${e.nummer}/">
           <span class="nr">${schuetze(e.nummer)}</span>
           <div class="text">${schuetze(e.text)}</div>${marken(e)}</a>`).join("")
    : `<p class="hinweis">Zu diesem Zeichen nennt der Katalog keinen Tatbestand,
         der die Nummer im Text führt.</p>`;

  return geruest({
    titel: `Verkehrszeichen ${z.nummer} – ${z.beschreibung}`,
    beschreibung: `Zeichen ${z.nummer}: ${z.beschreibung}. `
      + `${passende.length} zugehörige Tatbestände mit Bußgeld und Punkten.`,
    pfad: `/${PFAD_VZ}/${z.nummer}/`,
    hoch,
    inhalt: `
      <p class="nr" style="font-size:19px">Zeichen ${schuetze(z.nummer)}</p>
      <h1>${schuetze(z.beschreibung)}</h1>
      ${bild}
      ${liste}`,
  });
}

/** Suche ueber alle Zeichen — dieselbe Regel wie in der App. */
function zeichenSuchSeite(anzahl) {
  const skript = `
<script>
(function () {
  var daten = [], feld = document.getElementById("q"), liste = document.getElementById("liste");
  function zeichne() {
    var text = feld.value.trim().toLowerCase();
    // Wie VerkehrszeichenRepository.suche: Nummer oder Beschreibung enthaelt
    // den Suchtext. Ohne Eingabe alle, wie in der Uebersicht der App.
    var treffer = !text ? daten : daten.filter(function (z) {
      return z.n.toLowerCase().indexOf(text) >= 0 || z.b.toLowerCase().indexOf(text) >= 0;
    });
    liste.innerHTML = '<h1>' + treffer.length + (treffer.length === 1 ? ' Zeichen' : ' Zeichen') + '</h1>'
      + '<div class="zeichengitter">' + treffer.slice(0, 300).map(function (z) {
          return '<a class="zeichenkachel" href="' + encodeURIComponent(z.n) + '/">'
            + (z.i ? '<img src="../bilder/vz/' + encodeURIComponent(z.n) + '.png" alt="" loading="lazy">' : '')
            + '<span class="nr">' + z.n + '</span>'
            + '<span class="bez">' + z.b + '</span></a>';
        }).join("") + '</div>';
  }
  feld.addEventListener("input", zeichne);
  document.getElementById("suche").addEventListener("submit", function (e) { e.preventDefault(); zeichne(); });
  fetch("daten.json").then(function (r) { return r.json(); }).then(function (d) {
    daten = d;
    var start = new URLSearchParams(location.search).get("q");
    if (start) feld.value = start;
    zeichne();
  });
})();
</script>`;

  return geruest({
    titel: "Verkehrszeichen suchen – Tatbestandskatalog",
    beschreibung: `Alle ${anzahl} Verkehrszeichen mit Bild und Bedeutung — `
      + "dazu die passenden Tatbestände mit Bußgeld und Punkten.",
    pfad: `/${PFAD_VZ}/`,
    hoch: "../",
    skript,
    inhalt: `
      <form id="suche">
        <input type="search" id="q" placeholder="Zeichen oder Bedeutung suchen …" autofocus>
        <button type="submit">Suchen</button>
      </form>
      <p style="margin:-6px 0 18px"><a class="marke" style="padding:6px 12px"
         href="../katalog/">Oder nach Tatbeständen suchen →</a></p>
      <div id="liste"></div>
      <noscript><p class="hinweis">Für die Suche wird JavaScript benötigt.</p></noscript>`,
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
for (const alt of ["t", PFAD]) {
  if (existsSync(wurzel + alt)) await rm(wurzel + alt, { recursive: true });
}
await mkdir(wurzel + "katalog", { recursive: true });

for (const e of daten) {
  await mkdir(`${wurzel}${PFAD}/${e.nummer}`, { recursive: true });
  await writeFile(`${wurzel}${PFAD}/${e.nummer}/index.html`, tatbestandSeite(e, stufen(daten, e)));
}
console.log(`  ${daten.length} Seiten geschrieben`);

// ------------------------------------------------------- Verkehrszeichen

const { zeichen, quelle: vzQuelle } = await holeZeichen();
const bilderDa = new Set(
  (await readdir(wurzel + "bilder/vz").catch(() => []))
    .filter((d) => d.endsWith(".png"))
    .map((d) => d.slice(0, -4))
);
console.log(`  ${zeichen.length} Verkehrszeichen (${vzQuelle}), ${bilderDa.size} mit Bild`);

if (existsSync(wurzel + PFAD_VZ)) await rm(wurzel + PFAD_VZ, { recursive: true });
await mkdir(wurzel + PFAD_VZ, { recursive: true });

for (const z of zeichen) {
  // Zuordnung wie in beiden Apps: Die Zeichennummer kommt im Tatbestandstext
  // vor — dort steht sie als "<314/315>" oder "Zeichen 274".
  const passende = daten.filter((e) =>
    e.text.toLowerCase().includes(z.nummer.toLowerCase())
  );
  await mkdir(`${wurzel}${PFAD_VZ}/${z.nummer}`, { recursive: true });
  await writeFile(`${wurzel}${PFAD_VZ}/${z.nummer}/index.html`,
    zeichenSeite(z, passende, bilderDa.has(z.nummer)));
}
await writeFile(wurzel + PFAD_VZ + "/daten.json", JSON.stringify(
  zeichen.map((z) => ({ n: z.nummer, b: z.beschreibung, i: bilderDa.has(z.nummer) ? 1 : 0 }))));
await writeFile(wurzel + PFAD_VZ + "/index.html", zeichenSuchSeite(zeichen.length));
console.log(`  ${zeichen.length} Zeichenseiten geschrieben`);

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
  + `<url><loc>${BASIS}/${PFAD_VZ}/</loc></url>`
  + daten.map((e) => `<url><loc>${BASIS}/${PFAD}/${e.nummer}/</loc></url>`).join("")
  + zeichen.map((z) => `<url><loc>${BASIS}/${PFAD_VZ}/${encodeURIComponent(z.nummer)}/</loc></url>`).join("")
  + `</urlset>\n`);

// Der Katalog soll gefunden werden. Die rechtlichen Seiten tragen ihr eigenes
// noindex — dafuer muessen sie aber lesbar sein, deshalb kein Disallow.
await writeFile(wurzel + "robots.txt",
  `User-agent: *\nAllow: /\nSitemap: ${BASIS}/sitemap.xml\n`);

// ------------------------------------------------------- Startseite

/**
 * Vorrat fuer die Beispiele auf der Startseite.
 *
 * Die eigentliche Auswahl trifft der Browser bei jedem Aufruf neu — fertige
 * Dateien koennen das nicht. Damit die Datei nicht aufgeblaeht wird, liegt
 * hier nur eine feste Auswahl bereit, aus der gezogen wird. Die Auswahl des
 * Vorrats haengt am Inhalt, nicht an der Uhrzeit: Sonst bekaeme jeder Lauf
 * eine andere Startseite und die taegliche Action wuerde jedes Mal
 * einchecken, obwohl sich nichts geaendert hat.
 */
function vorrat(daten, wieViele) {
  const brauchbar = daten.filter((e) => e.bussgeld && Number(e.bussgeld) > 0);
  const gewaehlt = [];
  for (let i = 0; i < wieViele; i++) {
    gewaehlt.push(brauchbar[(i * 104729) % brauchbar.length]);
  }
  return gewaehlt;
}

/** Eine Beispielkarte. */
function karte(e) {
  return `<a class="karte" href="${PFAD}/${e.nummer}/">
      <span class="nr">${e.nummer}</span>
      <div class="text">${schuetze(e.text.length > 95 ? e.text.slice(0, 92) + "…" : e.text)}</div>
      ${marken(e)}
    </a>`;
}

/** Eine Zeichenkachel. */
function zeichenKachel(z) {
  return `<a class="zeichenkachel" href="${PFAD_VZ}/${encodeURIComponent(z.nummer)}/">
      <img src="bilder/vz/${encodeURIComponent(z.nummer)}.png" alt="" loading="lazy">
      <span class="nr">${schuetze(z.nummer)}</span>
      <span class="bez" title="${schuetze(z.beschreibung)}">${schuetze(z.beschreibung)}</span>
    </a>`;
}

/**
 * Zeichen, die sich als Beispiel eignen: Es gibt ein Bild, und der Katalog
 * fuehrt mindestens einen Tatbestand dazu. Ein Zeichen vorzuschlagen, hinter
 * dem dann nichts steht, waere eine Sackgasse.
 */
const zeichenVorrat = zeichen.filter(
  (z) => bilderDa.has(z.nummer)
    && daten.some((e) => e.text.toLowerCase().includes(z.nummer.toLowerCase()))
);
console.log(`  ${zeichenVorrat.length} Zeichen taugen als Beispiel`);

const startseite = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Tatbestandskatalog – alle Tatbestandsnummern mit Bußgeld und Punkten</title>
<meta name="description" content="Alle ${daten.length} Tatbestände des amtlichen Bußgeldkatalogs: Tatbestandsnummer, Bußgeld, Punkte und Fahrverbot. Durchsuchbar, kostenlos, auch als App.">
<link rel="canonical" href="${BASIS}/">
<meta name="apple-itunes-app" content="app-id=${APPLE_ID}">
<link rel="icon" href="bilder/icon-32.png" sizes="32x32">
<link rel="icon" href="bilder/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="bilder/icon-180.png">
<meta name="theme-color" content="${BLAU}">
<link rel="stylesheet" href="stil.css?v=${STILVERSION}">
</head>
<body>

<div class="buehne">
  <h1>Tatbestandskatalog</h1>
  <p>Alle ${daten.length} Tatbestände des amtlichen Bußgeldkatalogs —
     mit Nummer, Bußgeld, Punkten und Fahrverbot.</p>
  <form action="katalog/" method="get">
    <input type="search" name="q" placeholder="Tatbestand oder Nummer suchen …">
    <button type="submit">Suchen</button>
  </form>
  <!-- Die Zeichensuche steht gleichberechtigt neben der Tatbestandssuche,
       nicht erst weiter unten — sie ist der zweite Grund herzukommen. -->
  <div class="einstiege">
    <a href="katalog/">
      <img src="bilder/icon-192.png" alt="">
      <span><b>Tatbestände</b>${daten.length} Einträge mit Bußgeld und Punkten</span>
    </a>
    <a href="${PFAD_VZ}/">
      <img src="bilder/vz/206.png" alt="">
      <span><b>Verkehrszeichen</b>${zeichen.length} Zeichen mit passenden Tatbeständen</span>
    </a>
  </div>
</div>

<main>
  <!-- Zwei Spalten nebeneinander: Tatbestaende und Zeichen sind
       gleichwertige Einstiege, nicht Haupt- und Nebensache. -->
  <div class="zweispalten">
    <section>
      <h2>Beispiele aus dem Katalog</h2>
      <div class="karten" id="beispiele">
        ${vorrat(daten, 4).map(karte).join("")}
      </div>
      <p style="margin-top:12px"><a class="marke stark" style="padding:9px 16px"
         href="katalog/">Alle ${daten.length} Tatbestände →</a></p>
    </section>

    <section>
      <h2>Verkehrszeichen</h2>
      <div class="zeichengitter" id="zeichenbeispiele">
        ${zeichenVorrat.slice(0, 6).map(zeichenKachel).join("")}
      </div>
      <p style="margin-top:12px"><a class="marke stark" style="padding:9px 16px"
         href="${PFAD_VZ}/">Alle ${zeichen.length} Zeichen →</a></p>
    </section>
  </div>

  <h2>Unterwegs in der App</h2>
  <div class="apps">
    <img src="bilder/app.png" alt="App-Symbol Tatbestandskatalog">
    <img src="bilder/app2.png" alt="Alternatives App-Symbol">
    <div style="flex:1 1 200px">
      <p style="margin:0 0 10px">Offline nachschlagen, Tatbestände merken, eigene
         Notizen anlegen und Verkehrszeichen nachsehen.</p>
      <p style="margin:0">
        <a class="appknopf" href="${APPLE_LINK}">iPhone</a>
        <a class="appknopf" href="${PLAY_LINK}">Android</a>
      </p>
    </div>
  </div>
</main>

<footer>
  <p>Alle Angaben ohne Gewähr. Maßgeblich ist der amtliche Bußgeldkatalog.</p>
  <p>
    <a href="Datenschutzerkl%C3%A4rung.html">Datenschutzerklärung</a> ·
    <a href="Nutzungsbedingungen.html">Nutzungsbedingungen</a>
  </p>
  <p><strong>Impressum</strong> — Angaben gemäß § 5 TMG<br>
     Yacouba Pfälzner · <a href="mailto:developeryp1@gmail.com">developeryp1@gmail.com</a><br>
     Die vollständige Postadresse wird auf Anfrage per E-Mail mitgeteilt.</p>
</footer>

<script>
// Bei jedem Aufruf andere Beispiele. Im HTML steht bereits eine Auswahl —
// die sehen Suchmaschinen und alle ohne JavaScript; hier wird sie nur
// ausgetauscht.
(function () {
  var tatbestaende = ${JSON.stringify(vorrat(daten, 60).map((e) => karte(e)))};
  var zeichen = ${JSON.stringify(zeichenVorrat.map((z) => zeichenKachel(z)))};

  function ziehe(aus, wieViele) {
    var kopie = aus.slice(), raus = [];
    while (raus.length < wieViele && kopie.length) {
      raus.push(kopie.splice(Math.floor(Math.random() * kopie.length), 1)[0]);
    }
    return raus.join("");
  }
  var a = document.getElementById("beispiele");
  var b = document.getElementById("zeichenbeispiele");
  if (a) a.innerHTML = ziehe(tatbestaende, 4);
  if (b) b.innerHTML = ziehe(zeichen, 6);
})();
</script>
</body>
</html>`;
await writeFile(wurzel + "index.html", startseite);

console.log("Fertig.");
