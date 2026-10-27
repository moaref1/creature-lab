// Self-play league: a pool of frozen snapshots with Elo ratings. The learner plays the
// latest self or a sampled past opponent; results update ratings.
import { Rng } from '../util';

export interface LeagueEntry {
  id: string;
  checkpointId: string;
  elo: number;
  games: number;
}

export class League {
  entries: LeagueEntry[] = [];
  learnerElo = 1000;
  constructor(
    public poolSize = 8,
    public latestProb = 0.5,
  ) {}

  add(checkpointId: string) {
    this.entries.push({ id: `snap${this.entries.length + 1}`, checkpointId, elo: this.learnerElo, games: 0 });
    if (this.entries.length > this.poolSize) {
      // keep the strongest and the newest; drop the weakest older snapshot
      const newest = this.entries[this.entries.length - 1];
      const rest = this.entries.slice(0, -1).sort((a, b) => b.elo - a.elo).slice(0, this.poolSize - 1);
      this.entries = [...rest, newest];
    }
  }

  /** null = play against the current learner itself. Otherwise a past snapshot, weaker ones less often. */
  sample(rng: Rng): LeagueEntry | null {
    if (!this.entries.length || rng.next() < this.latestProb) return null;
    // prioritise opponents near or above the learner's rating
    const w = this.entries.map((e) => Math.exp((e.elo - this.learnerElo) / 200));
    const s = w.reduce((a, b) => a + b, 0);
    let u = rng.next() * s;
    for (let i = 0; i < w.length; i++) {
      u -= w[i];
      if (u <= 0) return this.entries[i];
    }
    return this.entries[this.entries.length - 1];
  }

  /** score: 1 learner won, 0 lost, 0.5 draw. */
  record(opponentId: string | null, score: number, k = 24) {
    const opp = opponentId ? this.entries.find((e) => e.id === opponentId) : null;
    const oppElo = opp ? opp.elo : this.learnerElo;
    const expected = 1 / (1 + Math.pow(10, (oppElo - this.learnerElo) / 400));
    this.learnerElo += k * (score - expected);
    if (opp) {
      opp.elo -= k * (score - expected);
      opp.games++;
    }
  }
}
