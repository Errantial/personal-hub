import { useEffect, useState } from 'react';
import {
  builtInProfiles,
  colorKeys,
  defaultAppearance,
  defaultColors,
  deriveColors,
  densities,
  maxProfileName,
  maxProfiles,
  readActiveProfile,
  readProfiles,
  sameAppearance,
  shapes,
  schemes,
  textSizes,
  writeActiveProfile,
  writeProfiles,
} from '../lib/appearance';
import type { Appearance, ColorKey, Colors, Profile } from '../lib/appearance';
import { useConfirm } from './ConfirmDialog';
import { Help } from './Help';
import { StatusChip } from './StatusChip';
import './AppearanceSettings.css';

const colorLabels: Record<ColorKey, string> = {
  accent: 'Accent',
  background: 'Background',
  surface: 'Surface',
  text: 'Text',
};
const schemeLabels = { system: 'Match device', light: 'Light', dark: 'Dark' };
const textSizeLabels = {
  small: 'Small',
  default: 'Default',
  large: 'Large',
  larger: 'Larger',
};
const densityLabels = {
  compact: 'Compact',
  comfortable: 'Comfortable',
  spacious: 'Spacious',
};
const shapeLabels = { square: 'Square', rounded: 'Rounded', round: 'Round' };

/** Settings › Appearance: display mode, colors, size, density, shape and
 *  device-local named profiles. Changes apply immediately and persist. */
export function AppearanceSettings({
  appearance,
  onChange,
}: {
  appearance: Appearance;
  onChange: (value: Appearance) => void;
}) {
  const [dialog, confirm] = useConfirm();
  const [profiles, setProfiles] = useState(readProfiles);
  const [activeId, setActiveId] = useState(readActiveProfile);
  const [draft, setDraft] = useState<Colors>(appearance.colors);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // Loading a profile or resetting replaces the colors from outside.
  useEffect(() => setDraft(appearance.colors), [appearance.colors]);
  useEffect(() => writeProfiles(profiles), [profiles]);
  useEffect(() => writeActiveProfile(activeId), [activeId]);

  const all = [...builtInProfiles, ...profiles];
  const active = all.find((profile) => profile.id === activeId);
  const modified = !!active && !sameAppearance(active.appearance, appearance);
  const problems = deriveColors(draft).problems;
  const defaults = { ...defaultAppearance, eink: appearance.eink };
  const customized = !sameAppearance(appearance, defaults);

  function change(patch: Partial<Appearance>) {
    setMessage('');
    onChange({ ...appearance, ...patch });
  }

  /** A color only applies while every contrast pair passes. */
  function setColor(key: ColorKey, value: string) {
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (!deriveColors(next).problems.length) change({ colors: next });
  }

  async function load(profile: Profile) {
    const unsaved = active ? modified : customized;
    if (
      unsaved &&
      !(await confirm({
        title: `Load “${profile.name}”?`,
        message: 'Unsaved appearance changes will be replaced.',
        confirmLabel: 'Load profile',
      }))
    ) {
      return;
    }
    setError('');
    setActiveId(profile.id);
    onChange(profile.appearance);
    setMessage(`Loaded “${profile.name}”.`);
  }

  /** Empty, too long, or a built-in name. */
  function nameError(candidate: string) {
    if (!candidate) return 'Enter a profile name.';
    if (candidate.length > maxProfileName) {
      return `Use at most ${maxProfileName} characters.`;
    }
    const builtIn = builtInProfiles.some(
      (profile) => profile.name.toLowerCase() === candidate.toLowerCase(),
    );
    return builtIn ? 'That name belongs to a built-in profile.' : '';
  }

  async function saveAs() {
    const candidate = name.trim();
    const invalid = nameError(candidate);
    if (invalid) return setError(invalid);
    const same = profiles.find(
      (profile) => profile.name.toLowerCase() === candidate.toLowerCase(),
    );
    if (!same && profiles.length >= maxProfiles) {
      return setError(`Delete a profile first; the limit is ${maxProfiles}.`);
    }
    if (
      same &&
      !(await confirm({
        title: `Replace “${same.name}”?`,
        message: 'The saved profile takes the current appearance.',
        confirmLabel: 'Replace profile',
      }))
    ) {
      return;
    }
    const saved: Profile = {
      id: same?.id ?? crypto.randomUUID(),
      name: same?.name ?? candidate,
      appearance,
    };
    setProfiles((current) =>
      same
        ? current.map((profile) => (profile.id === same.id ? saved : profile))
        : [...current, saved],
    );
    setActiveId(saved.id);
    setName('');
    setError('');
    setMessage(`Saved “${saved.name}”.`);
  }

  async function replace(profile: Profile) {
    if (
      !(await confirm({
        title: `Replace “${profile.name}”?`,
        message: 'The saved profile takes the current appearance.',
        confirmLabel: 'Replace profile',
      }))
    ) {
      return;
    }
    setProfiles((current) =>
      current.map((item) =>
        item.id === profile.id ? { ...item, appearance } : item,
      ),
    );
    setError('');
    setMessage(`Updated “${profile.name}”.`);
  }

  function rename() {
    if (!renaming) return;
    const candidate = renaming.name.trim();
    const taken = profiles.some(
      (profile) =>
        profile.id !== renaming.id &&
        profile.name.toLowerCase() === candidate.toLowerCase(),
    );
    const invalid =
      nameError(candidate) || (taken ? 'Another profile has that name.' : '');
    if (invalid) return setError(invalid);
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === renaming.id ? { ...profile, name: candidate } : profile,
      ),
    );
    setRenaming(null);
    setError('');
    setMessage(`Renamed to “${candidate}”.`);
  }

  async function remove(profile: Profile) {
    if (
      !(await confirm({
        title: `Delete “${profile.name}”?`,
        message: 'The current appearance does not change.',
        confirmLabel: 'Delete profile',
      }))
    ) {
      return;
    }
    setProfiles((current) => current.filter((item) => item.id !== profile.id));
    if (activeId === profile.id) setActiveId(null);
    setError('');
    setMessage(`Deleted “${profile.name}”.`);
  }

  return (
    <div className="preferences-grid">
      <section className="panel preference-panel">
        <h2>E-ink mode</h2>
        <Help label="E-ink">
          Black and white, no animation, larger controls and a stable layout.
          Use it on e-ink displays such as the Mudita Kompakt. Custom colors and
          corner shape are kept but not applied while it is on.
        </Help>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={appearance.eink}
            onChange={(event) => change({ eink: event.target.checked })}
          />
          Use e-ink mode
        </label>
      </section>

      <section className="panel preference-panel" aria-label="Display">
        <h2>Display</h2>
        <Help label="Display">
          Match device switches between light and dark with your phone or
          computer. Custom colors replace either theme. Compact spacing and
          small text never shrink controls below 44 px.
        </Help>
        <div className="appearance-fields">
          <SelectField
            label="Theme"
            value={appearance.scheme}
            options={schemes}
            labels={schemeLabels}
            disabled={appearance.eink}
            onChange={(scheme) => change({ scheme })}
          />
          <SelectField
            label="Text size"
            value={appearance.textSize}
            options={textSizes}
            labels={textSizeLabels}
            onChange={(textSize) => change({ textSize })}
          />
          <SelectField
            label="Spacing"
            value={appearance.density}
            options={densities}
            labels={densityLabels}
            onChange={(density) => change({ density })}
          />
          <SelectField
            label="Corners"
            value={appearance.shape}
            options={shapes}
            labels={shapeLabels}
            disabled={appearance.eink}
            onChange={(shape) => change({ shape })}
          />
        </div>
      </section>

      <section className="panel preference-panel" aria-label="Colors">
        <h2>Colors</h2>
        <Help label="Colors">
          Text needs 4.5:1 contrast and the accent 3:1. A color that would fall
          below that is not applied. Borders, muted text and button text are
          derived from these four.
        </Help>
        {appearance.eink && (
          <p role="status">
            Colors are not applied in e-ink mode, so they cannot be edited here.
            Saved colors return when it is off.
          </p>
        )}
        <div className="appearance-fields" hidden={appearance.eink}>
          {colorKeys.map((key) => (
            <div key={key} className="appearance-color">
              <label htmlFor={`appearance-${key}`}>{colorLabels[key]}</label>
              <span>
                <input
                  id={`appearance-${key}`}
                  type="color"
                  value={draft[key] ?? defaultColors[key]}
                  onChange={(event) => setColor(key, event.target.value)}
                />
                <code>{draft[key] ?? defaultColors[key]}</code>
              </span>
            </div>
          ))}
        </div>
        {problems.length > 0 && (
          <div role="alert" className="appearance-problems">
            <p>Not applied:</p>
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        <button
          type="button"
          className="secondary-button"
          disabled={!customized && !problems.length}
          onClick={() => {
            setMessage('');
            setDraft({});
            onChange(defaults);
          }}
        >
          Reset appearance
        </button>
        <div className="appearance-preview" aria-hidden="true">
          <strong>Preview</strong>
          <span>Body text on the surface.</span>
          <small>Muted secondary text.</small>
          <span className="appearance-preview__button">Primary action</span>
          <span className="appearance-preview__chip">Overdue</span>
          <span className="appearance-preview__error">Could not save.</span>
        </div>
      </section>

      <section className="panel preference-panel" aria-label="Profiles">
        <h2>Profiles</h2>
        <Help label="Profiles">
          Profiles are saved on this device only and are not synced. Loading one
          changes how the app looks, not your account, tasks, connections or AI
          settings.
        </Help>
        <p role="status">{message}</p>
        {error && <p role="alert">{error}</p>}
        <ul className="appearance-profiles">
          {all.map((profile) => {
            const builtIn = builtInProfiles.some(
              (item) => item.id === profile.id,
            );
            return (
              <li key={profile.id}>
                {renaming?.id === profile.id ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      rename();
                    }}
                  >
                    <label>
                      New name
                      <input
                        value={renaming.name}
                        maxLength={maxProfileName}
                        onChange={(event) =>
                          setRenaming({
                            id: profile.id,
                            name: event.target.value,
                          })
                        }
                      />
                    </label>
                    <button type="submit" className="secondary-button">
                      Save name
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setRenaming(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="appearance-profiles__name">
                      {profile.name}
                      {profile.id === activeId && (
                        <StatusChip>
                          {modified ? 'Modified' : 'Active'}
                        </StatusChip>
                      )}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      aria-label={`Load ${profile.name}`}
                      onClick={() => void load(profile)}
                    >
                      Load
                    </button>
                    {!builtIn && profile.id === activeId && modified && (
                      <button
                        type="button"
                        className="secondary-button"
                        aria-label={`Replace ${profile.name} with current`}
                        onClick={() => void replace(profile)}
                      >
                        Replace
                      </button>
                    )}
                    {!builtIn && (
                      <>
                        <button
                          type="button"
                          className="secondary-button"
                          aria-label={`Rename ${profile.name}`}
                          onClick={() =>
                            setRenaming({ id: profile.id, name: profile.name })
                          }
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="danger-button"
                          aria-label={`Delete ${profile.name}`}
                          onClick={() => void remove(profile)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <form
          className="appearance-save"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAs();
          }}
        >
          <label>
            Profile name
            <input
              value={name}
              maxLength={maxProfileName}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button type="submit" className="secondary-button">
            Save as profile
          </button>
        </form>
      </section>
      {dialog}
    </div>
  );
}

/** A labelled select over a fixed set of string options. */
function SelectField<T extends string>({
  label,
  value,
  options,
  labels,
  disabled = false,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const next = options.find((item) => item === event.target.value);
          if (next) onChange(next);
        }}
      >
        {options.map((item) => (
          <option key={item} value={item}>
            {labels[item]}
          </option>
        ))}
      </select>
    </label>
  );
}
