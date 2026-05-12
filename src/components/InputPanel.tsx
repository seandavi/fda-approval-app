import { useMemo } from "react";
import { parseBatchInput } from "../normalize";

export type InputMode = "single" | "batch";

interface Props {
  mode: InputMode;
  onModeChange: (m: InputMode) => void;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}

export function InputPanel({
  mode,
  onModeChange,
  value,
  onChange,
  onSubmit,
  disabled,
}: Props) {
  const parsed = useMemo(() => parseBatchInput(value), [value]);
  const count = mode === "single" ? (value.trim() ? 1 : 0) : parsed.length;

  return (
    <section className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-900">Drug names</h2>
        <div className="inline-flex rounded-md bg-slate-100 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => onModeChange("single")}
            className={`px-2.5 py-1 rounded ${
              mode === "single"
                ? "bg-white shadow-sm font-medium"
                : "text-slate-600"
            }`}
          >
            Single
          </button>
          <button
            type="button"
            onClick={() => onModeChange("batch")}
            className={`px-2.5 py-1 rounded ${
              mode === "batch"
                ? "bg-white shadow-sm font-medium"
                : "text-slate-600"
            }`}
          >
            Batch
          </button>
        </div>
      </div>

      {mode === "single" ? (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !disabled) onSubmit();
          }}
          placeholder="e.g. pembrolizumab, Keytruda, MK-3475"
          className="w-full rounded-md border-0 ring-1 ring-inset ring-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-sky-500"
          disabled={disabled}
        />
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="One drug per line (or comma-separated)&#10;pembrolizumab&#10;Keytruda&#10;MK-3475"
          rows={6}
          className="w-full rounded-md border-0 ring-1 ring-inset ring-slate-300 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-sky-500"
          disabled={disabled}
        />
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {count === 0
            ? "Nothing to look up yet"
            : `${count} ${count === 1 ? "name" : "names"} ready`}
        </span>
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || count === 0}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {disabled ? "Looking up…" : "Lookup"}
        </button>
      </div>
    </section>
  );
}
