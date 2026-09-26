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

  // --- 1) Reconstruire la liste des matchs à partir de l'API (source unique
  //         de vérité). Le PSG ne joue jamais deux matchs de C1 le même
  //         jour : on garde donc un seul match par date, quitte à fusionner
  //         d'éventuels doublons créés par le passé. On réutilise
  //         l'identifiant déjà existant pour cette date (en préférant un id
  //         "propre" du type "m3" à un id généré "cl-xxxxx") afin de ne pas
  //         perdre les pronostics déjà enregistrés dessus.
  const byDate = new Map();
  for (const existing of matches) {
    const d = existing.kickoff.slice(0, 10);
    const current = byDate.get(d);
    if (!current || (/^cl-/.test(current.id) && !/^cl-/.test(existing.id))) {
      byDate.set(d, existing);
    }
  }

  const newMatches = [];
  for (const m of psgMatches) {
    const kickoff = toParisKickoff(m.utcDate);
    const date = kickoff.slice(0, 10);
    const home = isPSG(m.homeTeam) ? 'PSG' : opponentName(m.homeTeam);
    const away = isPSG(m.awayTeam) ? 'PSG' : opponentName(m.awayTeam);
    const existing = byDate.get(date);
    const id = existing ? existing.id : ('cl-' + m.id);
    newMatches.push({ id, apiId: m.id, home, away, kickoff });
  }
  newMatches.sort((a, b) => a.kickoff.localeCompare(b.kickoff));

  const sortedOld = matches.slice().sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const changed = JSON.stringify(newMatches) !== JSON.stringify(sortedOld);
  matches = newMatches;

  if (changed) {
    await db.collection(COLLECTION).doc('matches').set({ value: JSON.stringify(matches), updatedAt: Date.now() });
    console.log(`Liste des matchs synchronisée avec l'API (${matches.length} match(s)).`);
  } else {
    console.log('Liste des matchs déjà à jour.');
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

  // --- 4) Liste des clubs de la compétition + logos (pour le menu déroulant
  //         "équipe qui remporte la Ligue des Champions" et l'affichage des
  //         matchs côté app) ---
  const teamNames = new Set();
  const teamCrests = {};
  for (const m of (data.matches || [])) {
    for (const team of [m.homeTeam, m.awayTeam]) {
      if (!team) continue;
      const displayName = isPSG(team) ? 'PSG' : opponentName(team);
      teamNames.add(displayName);
      if (team.crest && !teamCrests[displayName]) teamCrests[displayName] = team.crest;
    }
  }
  const clTeams = Array.from(teamNames).sort((a, b) => a.localeCompare(b, 'fr'));
  await db.collection(COLLECTION).doc('clTeams').set({ value: JSON.stringify(clTeams), updatedAt: Date.now() });
  await db.collection(COLLECTION).doc('teamCrests').set({ value: JSON.stringify(teamCrests), updatedAt: Date.now() });
  console.log(`${clTeams.length} club(s) et ${Object.keys(teamCrests).length} logo(s) enregistré(s).`);

  // --- 5) Liste des meilleurs buteurs actuels de la compétition, complétée
  //         par tout l'effectif du PSG (pour pouvoir parier sur un joueur
  //         du PSG même en tout début de saison, quand personne n'a encore
  //         marqué et que la liste des buteurs est donc vide ou courte) ---
  try {
    const scorersRes = await fetch(`${API_BASE}/competitions/${COMPETITION_CODE}/scorers?limit=50`, {
      headers: { 'X-Auth-Token': apiKey },
    });
    let topScorers = [];
    if (scorersRes.ok) {
      const scorersData = await scorersRes.json();
      topScorers = (scorersData.scorers || [])
        .slice()
        .sort((a, b) => (b.goals || 0) - (a.goals || 0))
        .map(s => s.player && s.player.name)
        .filter(Boolean);
    } else {
      console.log('Impossible de récupérer les meilleurs buteurs (HTTP ' + scorersRes.status + '), on réessaiera au prochain passage.');
    }

    const psgMatchWithId = psgMatches.find(m => (m.homeTeam && m.homeTeam.id) || (m.awayTeam && m.awayTeam.id));
    const psgTeamId = psgMatchWithId
      ? (isPSG(psgMatchWithId.homeTeam) ? psgMatchWithId.homeTeam.id : psgMatchWithId.awayTeam.id)
      : null;
    if (psgTeamId) {
      const squadRes = await fetch(`${API_BASE}/teams/${psgTeamId}`, {
        headers: { 'X-Auth-Token': apiKey },
      });
      if (squadRes.ok) {
        const squadData = await squadRes.json();
        const squadNames = (squadData.squad || []).map(p => p.name).filter(Boolean);
        for (const name of squadNames) {
          if (!topScorers.includes(name)) topScorers.push(name);
        }
      } else {
        console.log("Impossible de récupérer l'effectif du PSG (HTTP " + squadRes.status + ').');
      }
    }

    await db.collection(COLLECTION).doc('topScorers').set({ value: JSON.stringify(topScorers), updatedAt: Date.now() });
    console.log(`${topScorers.length} joueur(s) proposé(s) pour le pronostic "meilleur buteur".`);
  } catch (e) {
    console.log('Erreur lors de la récupération des buteurs/effectif :', e.message);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
