import { useState } from 'react';
import { academicWorkBrowseResponseSchema } from '@hub/contracts';
import type { AcademicWorkBrowseResponse } from '@hub/contracts';
import { liveRequestJson } from '../lib/api';
import { Help } from './Help';

type Work = AcademicWorkBrowseResponse['work'][number];
export type AcademicSelection = Pick<
  Work,
  'id' | 'version' | 'courseVersion' | 'title'
>;

export function AssistantAcademicPicker({
  selected,
  onChange,
  disabled,
}: {
  selected: AcademicSelection[];
  onChange: (items: AcademicSelection[]) => void;
  disabled: boolean;
}) {
  const [page, setPage] = useState<AcademicWorkBrowseResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(next = false) {
    setBusy(true);
    setError('');
    const query = new URLSearchParams({ courseState: 'active', limit: '50' });
    const cursor = next ? page?.nextAfter : null;
    if (cursor) {
      query.set('after', cursor.id);
      query.set('expectedCursorVersion', String(cursor.version));
      query.set('expectedCourseVersion', String(cursor.courseVersion));
    }
    try {
      setPage(
        await liveRequestJson(
          `/api/v1/academic-work/browse?${query}`,
          academicWorkBrowseResponseSchema,
        ),
      );
    } catch {
      setError(
        'Academic work could not be loaded. Reload the list to try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="assistant__academic">
      <summary>Academic work ({selected.length}/20)</summary>
      <Help label="Academic context">
        Select manual work for this ask only. Title, kind, deadline, effort,
        status and priority may be sent. Notes, grades and imported records are
        excluded. Labels can withhold selected items. Changed work or classes
        block the ask; remove and select the item again after reloading. Earlier
        eligible answers may still be sent as conversation history.
      </Help>
      <fieldset disabled={disabled || busy}>
        <legend className="visually-hidden">Academic context</legend>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void load()}
        >
          Reload academic work
        </button>
        {!!selected.length && (
          <ul aria-label="Selected academic work">
            {selected.map((item) => (
              <li key={item.id}>
                {item.title}{' '}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    onChange(selected.filter((value) => value.id !== item.id))
                  }
                >
                  Remove {item.title}
                </button>
              </li>
            ))}
          </ul>
        )}
        {page && (
          <p className="meta">
            {page.summary.totalCount} manual items in active classes. Showing{' '}
            {page.work.length} on this page.
          </p>
        )}
        {page?.work.map((item) => (
          <label className="checkbox-label" key={item.id}>
            <input
              type="checkbox"
              checked={selected.some((value) => value.id === item.id)}
              disabled={
                selected.length >= 20 &&
                !selected.some((value) => value.id === item.id)
              }
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [
                        ...selected,
                        {
                          id: item.id,
                          version: item.version,
                          courseVersion: item.courseVersion,
                          title: item.title,
                        },
                      ]
                    : selected.filter((value) => value.id !== item.id),
                )
              }
            />
            {item.courseName}: {item.title} -{' '}
            {item.dueDate ?? 'Deadline unknown'} -{' '}
            {item.estimatedMinutes === null
              ? 'Effort unknown'
              : `${item.estimatedMinutes} min`}{' '}
            - {item.status}
          </label>
        ))}
        {page?.nextAfter && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void load(true)}
          >
            Next academic page
          </button>
        )}
      </fieldset>
      {busy && <p role="status">Loading academic work...</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </details>
  );
}
