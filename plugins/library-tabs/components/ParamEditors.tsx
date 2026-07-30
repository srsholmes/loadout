/**
 * The controls behind a `ParamSpec`.
 *
 * One control per *shape* of input, not one per rule kind. `rule-params.ts`
 * says a playtime rule carries a minutes range and a title rule carries text;
 * this file knows how to render a range and how to render text. Thirty-two
 * kinds collapse into eight controls, which is the only way the accessibility
 * contract gets honoured uniformly:
 *
 * - every control is a real `<button>` / `<input>`, so native Tab order works
 *   when docked — the input path TabMaster is broken on;
 * - `focus-visible:ring-2` on all of them;
 * - 44px minimum height per `DESIGN.md`.
 *
 * Values are edited as a patch object rather than a whole rule, so the caller
 * owns how an edit is committed (immediately, or on Save).
 */

import { useState } from "react";
import { Field, TextInput, Toggle } from "@loadout/ui";
import type { ParamOption, ParamSpec, RangeUnit } from "../lib/rule-params";
import { formatBytes, formatMinutes } from "../lib/summarize";
import type { NumericRange } from "../lib/types";

export interface ParamEditorProps {
  spec: ParamSpec;
  /** Current value of `spec.key` on the rule being edited. */
  value: unknown;
  onChange: (value: unknown) => void;
  /**
   * Games available for the `picker` control, and the user's collections.
   * Absent while the library is still loading.
   */
  pickerOptions?: readonly ParamOption[];
}

// ── Shared bits ────────────────────────────────────────────────────────

const CONTROL = [
  "min-h-[44px] rounded-lg border border-base-300 bg-base-200 px-3",
  "text-base-content transition-colors",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
].join(" ");

const CHIP_ON = "border-primary bg-primary/20 text-base-content";
const CHIP_OFF = "border-base-300 bg-base-200 text-base-content/70 hover:text-base-content";

function Chip({
  label,
  hint,
  selected,
  onToggle,
  role,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onToggle: () => void;
  role: "checkbox" | "radio";
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      onClick={onToggle}
      className={[
        "flex min-h-[44px] flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-1 text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        selected ? CHIP_ON : CHIP_OFF,
      ].join(" ")}
    >
      <span className="text-sm">{label}</span>
      {hint ? <span className="text-xs opacity-60">{hint}</span> : null}
    </button>
  );
}

// ── Range ──────────────────────────────────────────────────────────────

/** Seconds per day, for the date control's day/epoch conversion. */
const DAY = 86_400;
const GIB = 1024 ** 3;

/**
 * Turn a stored number into what the user types, and back.
 *
 * A playtime range is stored in minutes but a person thinks in hours; a size
 * is stored in bytes but typed in GB. Doing that conversion here rather than
 * in the rule keeps the stored value canonical and the displayed value humane.
 */
interface UnitAdapter {
  /** Short suffix rendered beside the input. */
  suffix: string;
  toInput: (stored: number) => string;
  fromInput: (typed: string) => number | undefined;
  /** Read-back under the field, e.g. "2h 30m". */
  describe?: (stored: number) => string;
  type: "number" | "date";
}

function isoDay(epochSec: number): string {
  // Whole days only: nobody filters a library to an exact second, and a date
  // input cannot express one anyway.
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

const ADAPTERS: Record<RangeUnit, UnitAdapter> = {
  minutes: {
    suffix: "hours",
    type: "number",
    toInput: (m) => String(Math.round((m / 60) * 10) / 10),
    fromInput: (v) => (v.trim() === "" ? undefined : Math.round(Number(v) * 60)),
    describe: (m) => formatMinutes(m),
  },
  hours: {
    suffix: "hours",
    type: "number",
    toInput: (h) => String(h),
    fromInput: (v) => (v.trim() === "" ? undefined : Number(v)),
  },
  bytes: {
    suffix: "GB",
    type: "number",
    toInput: (b) => String(Math.round((b / GIB) * 10) / 10),
    fromInput: (v) => (v.trim() === "" ? undefined : Math.round(Number(v) * GIB)),
    describe: (b) => formatBytes(b),
  },
  percent: {
    suffix: "%",
    type: "number",
    toInput: (p) => String(p),
    fromInput: (v) => (v.trim() === "" ? undefined : Number(v)),
  },
  count: {
    suffix: "",
    type: "number",
    toInput: (n) => String(n),
    fromInput: (v) => (v.trim() === "" ? undefined : Number(v)),
  },
  date: {
    suffix: "",
    type: "date",
    toInput: isoDay,
    fromInput: (v) => {
      if (v.trim() === "") return undefined;
      const ms = Date.parse(`${v}T00:00:00Z`);
      return Number.isNaN(ms) ? undefined : Math.floor(ms / DAY / 1000) * DAY;
    },
    describe: (s) => isoDay(s),
  },
};

function RangeEditor({
  spec,
  range,
  onChange,
}: {
  spec: Extract<ParamSpec, { control: "range" }>;
  range: NumericRange;
  onChange: (next: NumericRange) => void;
}) {
  const unit = ADAPTERS[spec.unit];

  const bound = (key: "min" | "max", label: string) => {
    const stored = range[key];
    return (
      <label className="flex flex-1 flex-col gap-1">
        <span className="text-xs text-base-content/60">{label}</span>
        <div className="flex items-center gap-2">
          <input
            type={unit.type}
            inputMode={unit.type === "number" ? "decimal" : undefined}
            value={stored === undefined ? "" : unit.toInput(stored)}
            placeholder="Any"
            onChange={(event) => {
              const next = unit.fromInput(event.target.value);
              // Delete the key rather than storing undefined, so a range with
              // no bounds is `{}` — which `rules.ts` reads as incomplete.
              const merged: NumericRange = { ...range };
              if (next === undefined || Number.isNaN(next)) delete merged[key];
              else merged[key] = next;
              onChange(merged);
            }}
            className={`${CONTROL} w-full`}
          />
          {unit.suffix ? (
            <span className="text-xs text-base-content/60">{unit.suffix}</span>
          ) : null}
        </div>
      </label>
    );
  };

  const readBack =
    unit.describe && (range.min !== undefined || range.max !== undefined)
      ? [
          range.min !== undefined ? `from ${unit.describe(range.min)}` : null,
          range.max !== undefined ? `to ${unit.describe(range.max)}` : null,
        ]
          .filter(Boolean)
          .join(" ")
      : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-3">
        {bound("min", "At least")}
        {bound("max", "At most")}
      </div>
      {readBack ? (
        <span className="text-xs text-base-content/60">{readBack}</span>
      ) : null}
      <label className="mt-1 flex items-center gap-2">
        <Toggle
          checked={range.includeUnknown === true}
          onChange={(checked) => onChange({ ...range, includeUnknown: checked })}
          size="small"
        />
        <span className="text-xs text-base-content/60">
          Also include games we don&apos;t know this about
        </span>
      </label>
    </div>
  );
}

// ── Tokens ─────────────────────────────────────────────────────────────

/**
 * A list the user types into, one entry at a time.
 *
 * Deliberately not a comma-split of one text field: developer and publisher
 * names contain commas ("Sony Interactive Entertainment, Inc."), so splitting
 * silently corrupts them.
 */
function TokensEditor({
  values,
  placeholder,
  onChange,
}: {
  values: readonly string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const trimmed = draft.trim();
    if (trimmed === "" || values.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <TextInput
          value={draft}
          onChange={setDraft}
          placeholder={placeholder}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={draft.trim() === ""}
          className={`${CONTROL} shrink-0 disabled:opacity-40`}
        >
          Add
        </button>
      </div>
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {values.map((value) => (
            <li key={value}>
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v !== value))}
                aria-label={`Remove ${value}`}
                className={[
                  "flex min-h-[44px] items-center gap-2 rounded-lg border px-3",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  CHIP_ON,
                ].join(" ")}
              >
                <span className="text-sm">{value}</span>
                <span aria-hidden="true" className="opacity-60">
                  ×
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── Picker ─────────────────────────────────────────────────────────────

/** Multi-select over a supplied option list (collections, or the library). */
function PickerEditor({
  values,
  options,
  onChange,
}: {
  values: readonly string[];
  options: readonly ParamOption[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");

  if (options.length === 0) {
    return (
      <span className="text-xs text-base-content/60">
        Nothing to choose from yet — your library is still loading.
      </span>
    );
  }

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle))
    : options;

  const toggle = (value: string) =>
    onChange(
      values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value],
    );

  return (
    <div className="flex flex-col gap-2">
      {options.length > 8 ? (
        <TextInput value={query} onChange={setQuery} placeholder="Filter…" />
      ) : null}
      <div
        role="group"
        // Capped height: a 2000-game library must not render 2000 rows into a
        // sheet. The filter above is how you reach the rest.
        className="flex max-h-64 flex-col gap-1 overflow-y-auto"
      >
        {shown.slice(0, 200).map((option) => (
          <Chip
            key={option.value}
            role="checkbox"
            label={option.label}
            hint={option.hint}
            selected={values.includes(option.value)}
            onToggle={() => toggle(option.value)}
          />
        ))}
      </div>
      {shown.length > 200 ? (
        <span className="text-xs text-base-content/60">
          Showing the first 200 of {shown.length}. Type to narrow it down.
        </span>
      ) : null}
    </div>
  );
}

// ── Entry point ────────────────────────────────────────────────────────

/** Render the control a `ParamSpec` calls for. */
export function ParamEditor({
  spec,
  value,
  onChange,
  pickerOptions = [],
}: ParamEditorProps) {
  const body = (() => {
    switch (spec.control) {
      case "range":
        return (
          <RangeEditor
            spec={spec}
            range={(value as NumericRange | undefined) ?? {}}
            onChange={onChange}
          />
        );

      case "options": {
        const selected = (value as string[] | undefined) ?? [];
        return (
          <div role="group" className="flex flex-wrap gap-2">
            {spec.options.map((option) => (
              <Chip
                key={option.value}
                role="checkbox"
                label={option.label}
                hint={option.hint}
                selected={selected.includes(option.value)}
                onToggle={() =>
                  onChange(
                    selected.includes(option.value)
                      ? selected.filter((v) => v !== option.value)
                      : [...selected, option.value],
                  )
                }
              />
            ))}
          </div>
        );
      }

      case "choice":
        return (
          // A radiogroup rather than a `<select>`: the options carry hints
          // ("Broader — matches more games") that a dropdown cannot show, and
          // that hint is the whole point of spelling out anyOf/allOf.
          <div role="radiogroup" className="flex flex-wrap gap-2">
            {spec.options.map((option) => (
              <Chip
                key={option.value}
                role="radio"
                label={option.label}
                hint={option.hint}
                selected={value === option.value}
                onToggle={() => onChange(option.value)}
              />
            ))}
          </div>
        );

      case "text":
        return (
          <TextInput
            value={(value as string | undefined) ?? ""}
            onChange={onChange}
            placeholder={spec.placeholder}
          />
        );

      case "toggle":
        return (
          <Toggle
            checked={value === true}
            onChange={(checked) => onChange(checked)}
          />
        );

      case "number":
        return (
          <input
            type="number"
            inputMode="numeric"
            min={spec.min}
            max={spec.max}
            value={String((value as number | undefined) ?? "")}
            onChange={(event) => {
              const next = Number(event.target.value);
              onChange(Number.isNaN(next) ? 0 : next);
            }}
            className={`${CONTROL} w-32`}
          />
        );

      case "tokens":
        return (
          <TokensEditor
            values={(value as string[] | undefined) ?? []}
            placeholder={spec.placeholder}
            onChange={onChange}
          />
        );

      case "picker":
        return (
          <PickerEditor
            values={(value as string[] | undefined) ?? []}
            options={pickerOptions}
            onChange={onChange}
          />
        );
    }
  })();

  return (
    <Field label={spec.label}>
      <div className="flex flex-col gap-1">
        {body}
        {spec.helper ? (
          <span className="text-xs text-base-content/60">{spec.helper}</span>
        ) : null}
      </div>
    </Field>
  );
}
