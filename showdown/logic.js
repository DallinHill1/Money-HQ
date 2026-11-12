const number = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
export function weekKey(date = new Date()) {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const d = new Date(local + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export function seasonYear(date = new Date()) { return date.getUTCFullYear() - (date.getUTCMonth() < 2 ? 1 : 0); }
export function grade(game, mode, team) {
  if (['canceled', 'postponed'].includes(game.status)) return { result: 'void', points: 0 };
  if (game.status !== 'final' || game.home_score == null || game.away_score == null) return { result: 'pending', points: 0 };
  const delta = Number(game.home_score) - Number(game.away_score);
  if (mode === 'spread' && game.home_spread == null) return { result: 'pending', points: 0 };
  const margin = delta + (mode === 'spread' ? Number(game.home_spread) : 0);
  if (margin === 0) return { result: 'push', points: 0 };
  if (!(team === 'home' ? margin > 0 : margin < 0)) return { result: 'loss', points: 0 };
  const line = team === 'home' ? Number(game.home_spread) : -Number(game.home_spread);
  return { result: 'win', points: mode === 'spread' && line > 0 ? (line >= 5.5 ? 3 : 2) : 1 };
}
export function normalizeEvent(event, fallbackSeason) {
  const comp = event.competitions?.[0];
  const home = comp?.competitors?.find(t => t.homeAway === 'home');
  const away = comp?.competitors?.find(t => t.homeAway === 'away');
  const start = new Date(event.date);
  if (!home || !away || !Number.isFinite(start.getTime()) || !/^\d+$/.test(String(event.id))) return null;
  const type = event.status?.type || comp.status?.type || {};
  const status = /cancel/i.test(type.name) ? 'canceled' : /postpon/i.test(type.name) ? 'postponed' : type.completed ? 'final' : type.state === 'in' ? 'live' : 'scheduled';
  const rank = t => Number(t.curatedRank?.current) > 0 && Number(t.curatedRank.current) <= 25 ? Number(t.curatedRank.current) : null;
  const odds = comp.odds?.find(o => o.provider?.name === 'DraftKings') || comp.odds?.[0];
  // pointSpread.home is signed for the home team; do not infer direction from the headline favorite.
  const explicit = number(odds?.pointSpread?.home?.close?.line ?? odds?.pointSpread?.home?.current?.line);
  const raw = number(odds?.spread);
  const spread = explicit ?? (raw === null ? null : odds?.homeTeamOdds?.favorite ? -Math.abs(raw) : odds?.homeTeamOdds?.underdog ? Math.abs(raw) : raw === 0 ? 0 : null);
  const score = t => typeof t.score === 'object' ? number(t.score?.value) : number(t.score);
  return { id: String(event.id), week_id: weekKey(start), season: Number(event.season?.year || fallbackSeason), home: home.team.displayName, away: away.team.displayName,
    home_id: String(home.team.id), away_id: String(away.team.id), start_at: start.toISOString(), home_score: status === 'scheduled' ? null : score(home), away_score: status === 'scheduled' ? null : score(away),
    status, detail: String(type.shortDetail || type.detail || ''), home_rank: rank(home), away_rank: rank(away), home_spread: spread, line_source: spread === null ? null : `ESPN / ${odds?.provider?.name || 'consensus'}` };
}
export const mandatory = game => [game.home_id, game.away_id].some(id => ['252', '254'].includes(String(id)));
export function selectSlate(games, now = Date.now()) {
  const candidates = games.filter(g => g.status === 'scheduled' && new Date(g.start_at).getTime() > now);
  const interest = g => (g.home_rank && g.away_rank ? 1000 : 0) + (g.home_rank ? 30 - g.home_rank : 0) + (g.away_rank ? 30 - g.away_rank : 0) - Math.min(Math.abs(Number(g.home_spread || 0)), 40) / 100;
  return candidates.sort((a, b) => Number(mandatory(b)) - Number(mandatory(a)) || interest(b) - interest(a) || new Date(a.start_at).getTime() - new Date(b.start_at).getTime() || a.id.localeCompare(b.id)).slice(0, 8);
}
export function standings(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.member_id + ':' + row.mode;
    if (!map.has(key)) map.set(key, { id: row.member_id, name: row.name, mode: row.mode, wins: 0, losses: 0, pushes: 0, voids: 0, pending: 0, points: 0, submitted: 0 });
    const record = map.get(key), result = grade(row, row.mode, row.team);
    record.submitted++; record.points += result.points;
    record[{ win: 'wins', loss: 'losses', push: 'pushes', void: 'voids', pending: 'pending' }[result.result]]++;
  }
  const result = { straight: [], spread: [] };
  for (const r of map.values()) result[r.mode].push(r);
  for (const mode of ['straight', 'spread']) result[mode].sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name));
  return result;
}
