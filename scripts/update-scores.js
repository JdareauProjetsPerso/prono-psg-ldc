const admin = require('firebase-admin');

const ICS_FEED_URL = 'https://www.voetbalkrant.com/soccer/calendar/team/team_133_nl.ics';
const COLLECTION = 'prono_data';

function parseIcsEvents(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const dtMatch = block.match(/DTSTART[^:]*:(\d{8})/);
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    if (!dtMatch || !summaryMatch) continue;
    const raw = dtMatch[1];
    const isoDate = raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
    events.push({ date: isoDate, summary: summaryMatch[1].trim() });
  }
  return events;
}

function extractScoreFromSummary(summary) {
  const m = summary.match(/:\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (!m) return null;
  return { h: parseInt(m[1], 10), a: parseInt(m[2], 10) };
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing.');
  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const matchesDoc = await db.collection(COLLECTION).doc('matches').get();
  if (!matchesDoc.exists) { console.log('No matches doc found, nothing to do.'); return; }
  const matches = JSON.parse(matchesDoc.data().value);

  const scoresDoc = await db.collection(COLLECTION).doc('scores').get();
  const scores = scoresDoc.exists ? JSON.parse(scoresDoc.data().value) : {};

  const res = await fetch(ICS_FEED_URL);
  if (!res.ok) throw new Error('Failed to fetch ICS feed: HTTP ' + res.status);
  const icsText = await res.text();
  const events = parseIcsEvents(icsText);

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
