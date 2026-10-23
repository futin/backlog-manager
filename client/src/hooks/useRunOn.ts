import { useEffect, useState } from 'react';

import { EFFORT_OPTIONS, MODEL_OPTIONS } from '../lib/agents';
import { HOME_MACHINE, NO_MACHINE_TEXT, OFFERS_FAILED_TEXT, defaultMachine, lockedFor, narrowTo, showsPicker } from '../lib/dashboards';
import { useOffers } from './useOffers';
import { useSettings } from './useSettings';
import type { MachineOffer, ProjectOffers } from '../../../shared/types';

type Option = { value: string; label: string };

export interface RunOnState {
  /** The offers, or `null` while they load or when the read failed (then `failure` says so). The sheet draws `<RunOn>` from these. */
  offers: ProjectOffers | null;
  /** The picked machine id — `'home'` or a remote's name. Always a machine the offers know, or home. */
  machine: string;
  pick: (machine: string) => void;
  /** A REMOTE machine is picked: the request names it, Finish / Merge mode is PR, the lists are narrowed and the button says `Start on <label>`. */
  remote: boolean;
  /** The picked machine's label, or `null` on home — the word the hints and the button use. */
  label: string | null;
  lock: { prOnly: boolean; models: string[]; efforts: string[] };
  /** The values the selects show and a request sends — narrowed when a remote is picked, the person's own on home. */
  model: string;
  setModel: (m: string) => void;
  effort: string;
  setEffort: (e: string) => void;
  modelOptions: Option[];
  effortOptions: Option[];
  /** `{ machine }` for a remote and `{}` for home, spread into the request so a home launch carries no `machine` key at all (Review Focus 1). */
  request: { machine?: string };
  /** A launch has nowhere to go yet: the offers are loading, or no machine is offered. A failed read is NOT this — it falls back to home. */
  blocked: boolean;
  /** One line under the group when it has something to say that `<RunOn>` does not draw itself, else `null`. */
  note: string | null;
}

/**
 * The "Run on" state both launch sheets share (multi-dashboard task 9): the offers, the pick, and what the pick does to the sheet's other fields. One home so
 * the two sheets cannot disagree about what a remote machine locks.
 *
 * **The pick is a person's choice or the default, never stored twice.** `picked` is `null` until the person clicks a card; the machine is then derived — the
 * pick if the offers still know it, else `defaultMachine(offers)` (the suggestion, else the first offered, else home). A sheet that opens before the answer
 * lands is therefore on home, then moves to the suggestion when it arrives, and a person who has already clicked is never moved.
 *
 * **Model and effort are the one thing written back.** The sheets seed them from Settings, and a remote machine lists only some of the values, so on a remote
 * pick an unlisted value falls to the Settings default (or the first listed — `narrowTo`) and STAYS there when the person switches back to home: the ruling is
 * that a narrowed-away value is not restored, unlike Finish / Merge mode, which the sheets derive (`remote ? 'pr' : picked`) and so give back for free. The
 * returned `model` / `effort` are narrowed in render as well as written back, so no frame shows a value the machine does not list.
 *
 * A failed offers read with nothing to show is home: the sheet then does exactly what it did before the picker existed, and says so (`OFFERS_FAILED_TEXT`).
 * Blocking the launch on it would make the board's only launch path depend on a fan-out to machines that have nothing to do with a local run.
 */
export function useRunOn(project: string): RunOnState {
  const { settings } = useSettings();
  const { offers, error } = useOffers(project);
  const [picked, setPicked] = useState<string | null>(null);
  const [model, setModel] = useState(settings.dispatchDefaultModel);
  const [effort, setEffort] = useState(settings.dispatchDefaultEffort);

  const known = (id: string | null): MachineOffer | null => (id === null ? null : (offers?.machines.find((m) => m.machine === id) ?? null));
  const offer = known(picked) ?? known(defaultMachine(offers));
  const machine = offer?.machine ?? HOME_MACHINE;
  const remote = offer !== null && !offer.home;
  const lock = lockedFor(offer);

  const shownModel = narrowTo(model, lock.models, settings.dispatchDefaultModel);
  const shownEffort = narrowTo(effort, lock.efforts, settings.dispatchDefaultEffort);
  useEffect(() => {
    if (shownModel !== model) setModel(shownModel);
    if (shownEffort !== effort) setEffort(shownEffort);
  }, [shownModel, shownEffort, model, effort]);

  const asOptions = (list: string[]): Option[] => list.map((v) => ({ value: v, label: v }));
  const loading = offers === null && error === null;
  const noneOffered = offers !== null && !offers.machines.some((m) => m.offered);
  // The group draws the "no machine" line itself once it is drawn (two or more machines); a single unoffered home has no group to say it.
  const note = error !== null && offers === null ? OFFERS_FAILED_TEXT : offers !== null && noneOffered && !showsPicker(offers) ? NO_MACHINE_TEXT : null;

  return {
    offers,
    machine,
    pick: setPicked,
    remote,
    label: remote ? offer.label : null,
    lock,
    model: shownModel,
    setModel,
    effort: shownEffort,
    setEffort,
    modelOptions: lock.models.length > 0 ? asOptions(lock.models) : MODEL_OPTIONS,
    effortOptions: lock.efforts.length > 0 ? asOptions(lock.efforts) : EFFORT_OPTIONS,
    request: remote ? { machine } : {},
    blocked: loading || noneOffered || (offer !== null && !offer.offered),
    note
  };
}
