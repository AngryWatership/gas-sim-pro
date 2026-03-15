export interface GeneratorConfig {
  // Spatial dimensions
  randomiseWalls: boolean;
  wallCountMin: number;
  wallCountMax: number;
  wallLengthMin: number;
  wallLengthMax: number;

  randomiseDoors: boolean;
  doorCountMin: number;
  doorCountMax: number;
  doorWidthMin: number;
  doorWidthMax: number;

  randomiseLeaks: boolean;
  leakCountMin: number;
  leakCountMax: number;

  randomiseSensors: boolean;
  sensorCountMin: number;
  sensorCountMax: number;

  // Physics dimensions
  randomiseWind: boolean;
  windVectors: number;

  randomiseDiffusion: boolean;
  randomiseDecay: boolean;
  randomiseInjection: boolean;

  // Recording
  warmUpTicks: number;
  recordTicks: number;
  recordEvery: number;
}

export const defaultConfig: GeneratorConfig = {
  randomiseWalls: true,
  wallCountMin: 2,
  wallCountMax: 8,
  wallLengthMin: 10,
  wallLengthMax: 60,

  randomiseDoors: true,
  doorCountMin: 1,
  doorCountMax: 5,
  doorWidthMin: 1,
  doorWidthMax: 8,

  randomiseLeaks: true,
  leakCountMin: 1,
  leakCountMax: 8,

  randomiseSensors: true,
  sensorCountMin: 4,
  sensorCountMax: 30,

  randomiseWind: true,
  windVectors: 30,

  randomiseDiffusion: true,
  randomiseDecay: true,
  randomiseInjection: true,

  warmUpTicks: 300,
  recordTicks: 200,
  recordEvery: 10,
};

export const lockedConfig = (base: GeneratorConfig): string[] =>
  (Object.keys(base) as (keyof GeneratorConfig)[])
    .filter(k => k.startsWith('randomise') && base[k] === false)
    .map(k => k.replace('randomise', '').toLowerCase());