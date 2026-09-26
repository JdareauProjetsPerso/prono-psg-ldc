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
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
