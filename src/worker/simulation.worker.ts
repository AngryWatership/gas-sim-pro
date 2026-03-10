import { stepDiffusion } from "../engine/diffusion";
import type { SimulationState, SimParams } from "../engine/types";

interface WorkerMessage {
  state: SimulationState;
  params: SimParams;
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const nextState = stepDiffusion(e.data.state, e.data.params);
  self.postMessage(nextState, { transfer: [nextState.grid.buffer] });
};
