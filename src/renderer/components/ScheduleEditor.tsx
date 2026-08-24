/**
 * Where the user declares their working and peak hours.
 *
 * This is the one input the session planner cannot derive. ClaudeDeck can learn
 * *when you burn quota* from recorded history, but only you know *when it
 * matters* — a burst of 3am activity might be the one night you were
 * firefighting, not a preference. So this is a declaration, and the editor's job
 * is to make it quick to state and hard to state wrongly.
 *
 * Shared deliberately: the planner view and the onboarding wizard render the
 * same component, so the hours mean the same thing wherever they are set.
 */

import { useId, useMemo } from 'react';
import type { DaySpan, MinuteOfDay, Weekday, WorkSchedule } from '@shared/types';
import {
  MINUTES_PER_DAY,
  formatHHMM,
  parseHHMM,
  spanContains,
  spanLengthMin,
  validateSchedule,
} from '@core/schedule';
import { Icon } from './Icon';
import './schedule-editor.css';

/** Sunday-first, matching `Date#getDay`, with the index each chip carries. */
const DAYS: ReadonlyArray<{ index: Weekday; short: string; full: string }> = [
  { index: 0, short: 'S', full: 'Sunday' },
  { index: 1, short: 'M', full: 'Monday' },
  { index: 2, short: 'T', full: 'Tuesday' },
  { index: 3, short: 'W', full: 'Wednesday' },
  { index: 4, short: 'T', full: 'Thursday' },
  { index: 5, short: 'F', full: 'Friday' },
  { index: 6, short: 'S', full: 'Saturday' },
];

export interface ScheduleEditorProps {
  value: WorkSchedule;
  onChange: (next: WorkSchedule) => void;
  /** Hide the name field when there is only ever one schedule (onboarding). */
  showLabel?: boolean;
  /** Rendered under the fields — used for the "these are defaults" notice. */
  footnote?: string;
  disabled?: boolean;
}

/** A 24-hour strip showing work and peak, so the numbers are also a picture. */
function DayStrip({ work, peak }: { work: DaySpan; peak: DaySpan }) {
  // One cell per half hour: fine enough to read a 30-minute change, coarse
  // enough to stay a strip rather than a chart.
  const cells = useMemo(() => {
    const out: Array<'peak' | 'work' | 'off'> = [];
    for (let m = 0; m < MINUTES_PER_DAY; m += 30) {
      out.push(spanContains(peak, m) ? 'peak' : spanContains(work, m) ? 'work' : 'off');
    }
    return out;
  }, [work, peak]);

  const workLen = spanLengthMin(work);
  const peakLen = spanLengthMin(peak);
  const summary =
    `Working ${formatHHMM(work.start)} to ${formatHHMM(work.end)} (${hours(workLen)}), ` +
    `peak ${formatHHMM(peak.start)} to ${formatHHMM(peak.end)} (${hours(peakLen)}).`;

  return (
    <div className="cd-strip-wrap">
      {/* The strip is decorative; `summary` below carries the same facts as text. */}
      <div className="cd-strip" aria-hidden="true">
        {cells.map((kind, i) => (
          <span key={i} className={`cd-strip-cell cd-strip-cell--${kind}`} />
        ))}
      </div>
      <div className="cd-strip-axis" aria-hidden="true">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
            {h === 24 ? '24:00' : formatHHMM(h * 60)}
          </span>
        ))}
      </div>
      <p className="cd-strip-summary">{summary}</p>
    </div>
  );
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function TimeField({
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: MinuteOfDay;
  onChange: (next: MinuteOfDay) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="cd-timefield">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="time"
        value={formatHHMM(value)}
        disabled={disabled}
        onChange={(e) => {
          // A time input can be momentarily empty while being edited; ignore
          // that rather than snapping the value to midnight under the cursor.
          const parsed = parseHHMM(e.target.value);
          if (parsed !== null) onChange(parsed);
        }}
      />
      {hint ? <span className="cd-timefield-hint">{hint}</span> : null}
    </div>
  );
}

export function ScheduleEditor({
  value,
  onChange,
  showLabel = true,
  footnote,
  disabled = false,
}: ScheduleEditorProps) {
  const problems = useMemo(() => validateSchedule(value), [value]);
  const labelId = useId();

  const setSpan = (key: 'work' | 'peak', edge: 'start' | 'end') => (minute: MinuteOfDay) =>
    onChange({ ...value, [key]: { ...value[key], [edge]: minute } });

  const toggleDay = (day: Weekday) => {
    const has = value.days.includes(day);
    const days = has ? value.days.filter((d) => d !== day) : [...value.days, day].sort((a, b) => a - b);
    onChange({ ...value, days });
  };

  return (
    <div className="cd-sched">
      {showLabel ? (
        <div className="cd-sched-row">
          <label htmlFor={labelId}>Name</label>
          <input
            id={labelId}
            type="text"
            value={value.label}
            disabled={disabled}
            maxLength={40}
            placeholder="Weekdays"
            onChange={(e) => onChange({ ...value, label: e.target.value })}
          />
        </div>
      ) : null}

      <fieldset className="cd-sched-days" disabled={disabled}>
        <legend>Days this applies to</legend>
        <div className="cd-sched-chips">
          {DAYS.map((day) => {
            const on = value.days.includes(day.index);
            return (
              <button
                key={day.index}
                type="button"
                className={`cd-daychip${on ? ' cd-daychip--on' : ''}`}
                aria-pressed={on}
                aria-label={day.full}
                title={day.full}
                onClick={() => toggleDay(day.index)}
              >
                {day.short}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="cd-sched-times" disabled={disabled}>
        <legend>Working hours</legend>
        <TimeField label="From" value={value.work.start} onChange={setSpan('work', 'start')} />
        <TimeField label="To" value={value.work.end} onChange={setSpan('work', 'end')} />
      </fieldset>

      <fieldset className="cd-sched-times" disabled={disabled}>
        <legend>Peak hours</legend>
        <TimeField
          label="From"
          value={value.peak.start}
          onChange={setSpan('peak', 'start')}
          hint="The stretch you least want to run out in."
        />
        <TimeField label="To" value={value.peak.end} onChange={setSpan('peak', 'end')} />
      </fieldset>

      <DayStrip work={value.work} peak={value.peak} />

      {problems.length > 0 ? (
        <ul className="cd-sched-problems">
          {problems.map((problem) => (
            <li key={problem}>
              <Icon name="alert-triangle" size={14} />
              <span>{problem}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {footnote ? <p className="cd-sched-footnote">{footnote}</p> : null}
    </div>
  );
}

export default ScheduleEditor;
