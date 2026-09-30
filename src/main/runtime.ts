import { decide } from "../domain/state-transition";
import type { Event } from "../domain/events";
import type { DomainState } from "../domain/model";
import type { SqliteStore } from "./persistence/sqlite-store";

export class Runtime {
  private state: DomainState;
  constructor(
    private readonly store: SqliteStore,
    initialState = store.loadState(),
  ) {
    this.state = initialState;
  }
  snapshot(): DomainState {
    return structuredClone(this.state);
  }
  dispatch(event: Event): DomainState {
    return this.dispatchMany([event]);
  }
  dispatchMany(events: Event[]): DomainState {
    let nextState = this.state;
    const effects = [] as import("../domain/events").Effect[];
    for (const event of events) {
      const decision = decide(nextState, event);
      nextState = decision.state;
      effects.push(...decision.effects);
    }
    this.store.commit({ state: nextState, effects });
    this.state = nextState;
    return this.snapshot();
  }
}
