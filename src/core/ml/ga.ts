// Genetic algorithm in the style of The Nature of Code (ch. 9, Smart Rockets):
// fitness-proportional selection (a "mating pool"), midpoint or uniform crossover and
// per-gene mutation. A genome is any flat parameter vector (DNA or network weights).
import { Rng } from '../util';

export interface GAParams {
  population: number;
  mutationRate: number; // chance per gene
  mutation: 'replace' | 'nudge'; // replace = new random gene (Shiffman); nudge = add noise
  mutationSize: number;
  geneRange: number; // random genes are uniform in [-range, range]
  crossover: 'midpoint' | 'uniform' | 'none';
  fitnessPower: number; // fitness^power sharpens selection (Shiffman squares it)
  elitism: number; // best genomes copied unchanged
}
export const defaultGA: GAParams = { population: 100, mutationRate: 0.01, mutation: 'replace', mutationSize: 0.3, geneRange: 1, crossover: 'midpoint', fitnessPower: 2, elitism: 1 };

export class GeneticAlgorithm {
  p: GAParams;
  pop: Float32Array[];
  generation = 0;
  record = -Infinity;
  recordGenome: Float32Array;
  private rng: Rng;
  constructor(size: number, params: Partial<GAParams> = {}, seed = 1, start?: Float32Array) {
    this.p = { ...defaultGA, ...params };
    this.rng = new Rng(seed * 4241 + 5);
    this.pop = Array.from({ length: Math.max(2, this.p.population | 0) }, (_, k) => {
      const g = new Float32Array(size);
      // a warm start keeps one exact copy; everyone else is random DNA (or noise around it)
      for (let i = 0; i < size; i++) g[i] = start && k === 0 ? start[i] : start && this.p.mutation === 'nudge' ? start[i] + this.rng.normal() * this.p.mutationSize : this.randGene();
      return g;
    });
    this.recordGenome = Float32Array.from(this.pop[0]);
  }
  private randGene() {
    return (this.rng.next() * 2 - 1) * this.p.geneRange;
  }
  /** Fitness for each genome of the current generation -> next generation. */
  evolve(fitness: number[]) {
    const N = this.pop.length;
    let best = 0;
    for (let i = 1; i < N; i++) if (fitness[i] > fitness[best]) best = i;
    if (fitness[best] > this.record) {
      this.record = fitness[best];
      this.recordGenome = Float32Array.from(this.pop[best]);
    }
    // shift to positive, normalise to [0, 1], raise to a power (selection pressure)
    let lo = Infinity,
      hi = -Infinity;
    for (const f of fitness) {
      lo = Math.min(lo, f);
      hi = Math.max(hi, f);
    }
    const span = hi - lo || 1;
    const w = fitness.map((f) => Math.pow((f - lo) / span + 1e-3, this.p.fitnessPower));
    const total = w.reduce((a, b) => a + b, 0);
    const pick = () => {
      let r = this.rng.next() * total;
      for (let i = 0; i < N; i++) if ((r -= w[i]) <= 0) return this.pop[i];
      return this.pop[N - 1];
    };
    const order = fitness.map((f, i) => [f, i] as const).sort((a, b) => b[0] - a[0]);
    const next: Float32Array[] = [];
    for (let e = 0; e < Math.min(this.p.elitism, N); e++) next.push(Float32Array.from(this.pop[order[e][1]]));
    const size = this.pop[0].length;
    while (next.length < N) {
      const a = pick(),
        b = pick();
      const child = new Float32Array(size);
      const mid = Math.floor(this.rng.next() * size);
      for (let i = 0; i < size; i++) {
        if (this.p.crossover === 'midpoint') child[i] = i > mid ? a[i] : b[i];
        else if (this.p.crossover === 'uniform') child[i] = this.rng.next() < 0.5 ? a[i] : b[i];
        else child[i] = a[i];
        if (this.rng.next() < this.p.mutationRate) child[i] = this.p.mutation === 'replace' ? this.randGene() : child[i] + this.rng.normal() * this.p.mutationSize;
      }
      next.push(child);
    }
    this.pop = next;
    this.generation++;
    return { best: fitness[best], bestIndex: best, mean: fitness.reduce((a, b) => a + b, 0) / N };
  }
}
