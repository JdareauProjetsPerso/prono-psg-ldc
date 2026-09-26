const admin = require('firebase-admin');

const ICS_FEED_URL = 'https://www.voetbalkrant.com/soccer/calendar/team/team_133_nl.ics';
const COLLECTION = 'prono_data';

// Noms possibles du PSG dans le flux, normalisés vers "PSG" pour coller
// à la convention utilisée dans l'app.
const PSG_ALIASES = ['psg', 'paris saint-germain', 'paris saint germain', 'paris sg'];

// Mots-clés indiquant que le match appartient à la Ligue des Champions.
// Sert de garde-fou pour ne pas importer des matchs de Ligue 1, Coupe de
// France, amicaux, etc.
const CL_KEYWORDS = ['champions league', 'ligue des champions', 'uefa champions', 'ucl'];

function unfoldIcs(text) {
  // Les lignes ICS trop longues sont repliées sur la ligne suivante avec un
  // espace/tab en début de ligne : on les rejoint avant de parser.
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseIcsEvents(icsText) {
  const text = unfoldIcs(icsText);
  const events = [];
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const dtMatch = block.match(/DTSTART[^:\n]*:(\d{8})(?:T(\d{6}))?/);
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    if (!dtMatch || !summaryMatch) continue;
    const rawDate = dtMatch[1];
    const rawTime = dtMatch[2];
    const isoDate = rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8);
    const isoTime = rawTime ? rawTime.slice(0, 2) + ':' + rawTime.slice(2, 4) : '21:00';
    const descMatch = block.match(/DESCRIPTION:(.+)/);
    const catMatch = block.match(/CATEGORIES:(.+)/);
    events.push({
      date: isoDate,
      kickoff: isoDate + 'T' + isoTime,
      summary: summaryMatch[1].trim(),
      meta: [summaryMatch[1], descMatch ? descMatch[1] : '', catMatch ? catMatch[1] : ''].join(' '),
    });
  }
  return events;
}

function extractScoreFromSummary(summary) {
  const m = summary.match(/:\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return null;
  return { h: parseInt(m[1], 10), a: parseInt(m[2], 10) };
}

function isChampionsLeagueEvent(event) {
  const lower = event.meta.toLowerCase();
  return CL_KEYWORDS.some(kw => lower.includes(kw));
}

function normalizeTeam(name) {
  const trimmed = name.trim();
  const lower = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // enlève les accents
  return PSG_ALIASES.includes(lower) ? 'PSG' : trimmed;
}

function parseTeams(summary) {
  // Enlève un éventuel score final en fin de texte ("... : 3-1").
  let base = summary.replace(/:\s*\d+\s*-\s*\d+\s*$/, '').trim();
  // Enlève un éventuel préfixe de compétition suivi de ":" ("Champions League: PSG - Bayern").
  const colonIdx = base.indexOf(':');
  if (colonIdx !== -1 && base.slice(colonIdx + 1).includes(' - ')) {
    base = base.slice(colonIdx + 1).trim();
  }
  const parts = base.split(/\s-\s/);
  if (parts.length !== 2) return null;
  const home = normalizeTeam(parts[0]);
  const away = normalizeTeam(parts[1]);
  if (home !== 'PSG' && away !== 'PSG') return null;
  return { home, away };
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function opponentOf(match) {
  return match.home === 'PSG' ? match.away : match.home;
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing.');
  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const matchesDoc = await db.collection(COLLECTION).doc('matches').get();
  if (!matchesDoc.exists) { console.log('No matches doc found, nothing to do.'); return; }
  let matches = JSON.parse(matchesDoc.data().value);

  const scoresDoc = await db.collection(COLLECTION).doc('scores').get();
  const scores = scoresDoc.exists ? JSON.parse(scoresDoc.data().value) : {};

  const res = await fetch(ICS_FEED_URL);
  if (!res.ok) throw new Error('Failed to fetch ICS feed: HTTP ' + res.status);
  const icsText = await res.text();
  const events = parseIcsEvents(icsText);

  // --- 1) Repérer et ajouter les nouveaux matchs de Ligue des Champions ---
  let added = 0;
  for (const event of events) {
    if (!isChampionsLeagueEvent(event)) continue;
    const teams = parseTeams(event.summary);
    if (!teams) continue;

    const opponent = teams.home === 'PSG' ? teams.away : teams.home;
    const alreadyKnown = matches.some(m => m.kickoff.slice(0, 10) === event.date
      && slugify(opponentOf(m)) === slugify(opponent));
    if (alreadyKnown) continue;

    const newMatch = {
      id: 'auto-' + event.date.replace(/-/g, '') + '-' + slugify(opponent),
      home: teams.home,
      away: teams.away,
      kickoff: event.kickoff,
    };
    matches.push(newMatch);
    added++;
    console.log(`Nouveau match ajouté : ${newMatch.home} vs ${newMatch.away} (${newMatch.kickoff})`);
  }

  if (added > 0) {
    matches.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    await db.collection(COLLECTION).doc('matches').set({ value: JSON.stringify(matches), updatedAt: Date.now() });
    console.log(`${added} nouveau(x) match(s) écrit(s) dans Firestore.`);
  } else {
    console.log('Aucun nouveau match à ajouter.');
  }

  // --- 2) Mettre à jour les scores des matchs connus ---
  let updated = 0;
  for (const m of matches) {
    const kickoffDate = m.kickoff.slice(0, 10);
    const event = events.find(ev => ev.date === kickoffDate);
    if (!event) continue;
    const score = extractScoreFromSummary(event.summary);
    if (!score) continue;
    if (scores[m.id] && scores[m.id].h === score.h && scores[m.id].a === score.a) continue;
    scores[m.id] = score;
    updated++;
    console.log(`Updated ${m.home} vs ${m.away}: ${score.h}-${score.a}`);
  }

  if (updated > 0) {
    await db.collection(COLLECTION).doc('scores').set({ value: JSON.stringify(scores), updatedAt: Date.now() });
    console.log(`${updated} score(s) written to Firestore.`);
  } else {
    console.log('No new scores to update.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
