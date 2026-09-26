const admin = require('firebase-admin');

const API_BASE = 'https://api.football-data.org/v4';
const COMPETITION_CODE = 'CL'; // UEFA Champions League
const COLLECTION = 'prono_data';

function isPSG(team) {
  if (!team) return false;
  const name = (team.name || '').toLowerCase();
  const short = (team.shortName || '').toLowerCase();
  const tla = (team.tla || '').toLowerCase();
  return name.includes('paris saint-germain') || short === 'psg' || tla === 'psg';
}

function opponentName(team) {
  return team.shortName || team.name || 'Adversaire inconnu';
}

// Convertit une date UTC ISO (renvoyée par l'API) en "YYYY-MM-DDTHH:MM"
// heure de Paris, pour rester cohérent avec le format déjà utilisé côté app.
function toParisKickoff(utcDateStr) {
  const d = new Date(utcDateStr);
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
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
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) throw new Error('FOOTBALL_DATA_API_KEY secret is missing.');
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

  const res = await fetch(`${API_BASE}/competitions/${COMPETITION_CODE}/matches`, {
    headers: { 'X-Auth-Token': apiKey },
  });
  if (res.status === 429) {
    console.log('Limite de requêtes atteinte (football-data.org), on réessaiera au prochain passage.');
    return;
  }
  if (!res.ok) throw new Error('Failed to fetch football-data.org: HTTP ' + res.status);
  const data = await res.json();

  const psgMatches = (data.matches || []).filter(m => isPSG(m.homeTeam) || isPSG(m.awayTeam));

  // --- 1) Repérer et ajouter les nouveaux matchs de Ligue des Champions ---
  let added = 0;
  for (const m of psgMatches) {
    const kickoff = toParisKickoff(m.utcDate);
    const date = kickoff.slice(0, 10);
    const home = isPSG(m.homeTeam) ? 'PSG' : opponentName(m.homeTeam);
    const away = isPSG(m.awayTeam) ? 'PSG' : opponentName(m.awayTeam);
    const opponent = home === 'PSG' ? away : home;

    const alreadyKnown = matches.some(x => x.kickoff.slice(0, 10) === date
      && slugify(opponentOf(x)) === slugify(opponent));
    if (alreadyKnown) continue;

    const newMatch = { id: 'cl-' + m.id, apiId: m.id, home, away, kickoff };
    matches.push(newMatch);
    added++;
    console.log(`Nouveau match ajouté : ${home} vs ${away} (${kickoff})`);
  }

  if (added > 0) {
    matches.sort((a, b) => a.kickoff.localeCompare(b.kickoff));
    await db.collection(COLLECTION).doc('matches').set({ value: JSON.stringify(matches), updatedAt: Date.now() });
    console.log(`${added} nouveau(x) match(s) écrit(s) dans Firestore.`);
  } else {
    console.log('Aucun nouveau match à ajouter.');
  }

  // --- 2) Mettre à jour les scores, y compris en cours de match ---
  let updated = 0;
  for (const mt of matches) {
    const date = mt.kickoff.slice(0, 10);
    const apiMatch = psgMatches.find(m => toParisKickoff(m.utcDate).slice(0, 10) === date);
    if (!apiMatch) continue;
    const ft = apiMatch.score && apiMatch.score.fullTime;
    if (!ft || ft.home === null || ft.away === null) continue;
    const score = { h: ft.home, a: ft.away };
    if (scores[mt.id] && scores[mt.id].h === score.h && scores[mt.id].a === score.a) continue;
    scores[mt.id] = score;
    updated++;
    console.log(`Updated ${mt.home} vs ${mt.away}: ${score.h}-${score.a} (statut : ${apiMatch.status})`);
  }

  if (updated > 0) {
    await db.collection(COLLECTION).doc('scores').set({ value: JSON.stringify(scores), updatedAt: Date.now() });
    console.log(`${updated} score(s) written to Firestore.`);
  } else {
    console.log('No new scores to update.');
  }

  // --- 3) Statut "en direct" (pour afficher un badge côté app) ---
  const LIVE_STATUSES = ['IN_PLAY', 'PAUSED'];
  const liveStatus = {};
  for (const mt of matches) {
    const date = mt.kickoff.slice(0, 10);
    const apiMatch = psgMatches.find(m => toParisKickoff(m.utcDate).slice(0, 10) === date);
    if (apiMatch && LIVE_STATUSES.includes(apiMatch.status)) {
      liveStatus[mt.id] = apiMatch.status;
    }
  }
  await db.collection(COLLECTION).doc('liveStatus').set({ value: JSON.stringify(liveStatus), updatedAt: Date.now() });
  if (Object.keys(liveStatus).length > 0) {
    console.log('Match(s) en direct :', JSON.stringify(liveStatus));
  } else {
    console.log('Aucun match en direct actuellement.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
