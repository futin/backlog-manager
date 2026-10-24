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
  /** The offers have not answered yet (a failed read is not loading). `machine` reads home until they do, so a sheet that draws something only on home — the
   *  launch sheet's groom Finish — waits on this rather than drawing it for one frame and taking it away when a suggested remote lands. */
  loading: boolean;
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
 * **Model and effort are the one thing written back, and what is written is the Settings default.** The sheets seed them from Settings, and a remote machine
 * lists only some of the values, so on a remote pick an unlisted value is shown as `narrowTo`'s answer — the Settings default if the machine lists it, else the
 * first listed — and the state underneath is reset to the Settings default itself. Switching back to home therefore restores the Settings default, not the
 * narrowed value and not the person's own pre-lock pick: the final-review I4 ruling, per Review Focus 5 and Task 9's brief case (haiku with Settings opus,
 * pick Pro → opus, back home → opus). A Settings default the machine does not list is shown as its first value while remote and comes back whole on home.
 * Finish / Merge mode need none of this — the sheets derive them (`remote ? 'pr' : picked`) and so give them back for free. The returned `model` / `effort`
 * are narrowed in render as well, so no frame shows a value the machine does not list.
 *
 * **`''` is never narrowed.** It is the Settings "default" — no pick — and goes out as no key at all, which every machine accepts (`narrowTo` says why), so a
 * remote's select keeps a "default" option ahead of its own list for `''` to be drawn as. A person who never chose an effort launches on Pro and on home
 * alike with no `effort` in the body.
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
  // Reset to the Settings default, not to the shown value: the two differ only when the machine lists neither the value nor the default, and then the
  // default is what home must get back. Once state IS the default this is a no-op, so a default the machine does not list cannot loop the effect.
  const modelDefault = settings.dispatchDefaultModel;
  const effortDefault = settings.dispatchDefaultEffort;
  useEffect(() => {
    if (shownModel !== model && model !== modelDefault) setModel(modelDefault);
    if (shownEffort !== effort && effort !== effortDefault) setEffort(effortDefault);
  }, [shownModel, shownEffort, model, effort, modelDefault, effortDefault]);

  // The leading "default" entry is MODEL_OPTIONS' own first one, so a remote's select draws `''` with the same label home does.
  const asOptions = (list: string[], all: Option[]): Option[] => [all[0], ...list.map((v) => ({ value: v, label: v }))];
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
    modelOptions: lock.models.length > 0 ? asOptions(lock.models, MODEL_OPTIONS) : MODEL_OPTIONS,
    effortOptions: lock.efforts.length > 0 ? asOptions(lock.efforts, EFFORT_OPTIONS) : EFFORT_OPTIONS,
    request: remote ? { machine } : {},
    blocked: loading || noneOffered || (offer !== null && !offer.offered),
    loading,
    note
  };
}
