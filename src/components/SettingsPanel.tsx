import { useState } from "react";
import { trackEvent } from "../analytics";
import { clearCache } from "../cache";
import type { AppSettings } from "../types";
import { InfoTooltip } from "./InfoTooltip";

interface Props {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
}

export function SettingsPanel({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  const [clearedMsg, setClearedMsg] = useState<string | null>(null);

  function save() {
    onChange(draft);
    if (draft.openfdaApiKey && draft.openfdaApiKey !== settings.openfdaApiKey) {
      trackEvent("api_key_set");
    }
  }

  function doClearCache() {
    const n = clearCache();
    setClearedMsg(`Cleared ${n} cached ${n === 1 ? "entry" : "entries"}`);
    trackEvent("cache_cleared");
    setTimeout(() => setClearedMsg(null), 2500);
  }

  return (
    <section className="bg-white rounded-lg shadow-sm ring-1 ring-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-900"
      >
        <span>Settings</span>
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              openFDA API key
              <InfoTooltip
                side="bottom"
                text="Optional. Without a key, openFDA limits unauthenticated traffic to 240 requests/min per IP. Get one (free) at open.fda.gov/apis/authentication."
              />
            </label>
            <input
              type="text"
              value={draft.openfdaApiKey}
              onChange={(e) =>
                setDraft({ ...draft, openfdaApiKey: e.target.value })
              }
              placeholder="optional — leave blank for 240/min"
              className="w-full rounded-md ring-1 ring-inset ring-slate-300 px-3 py-1.5 font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Cache TTL (days)
              <InfoTooltip
                side="bottom"
                text="Resolved drug results are stored in your browser's localStorage. Cached entries older than this many days are re-fetched. Set to 0 to disable caching."
              />
            </label>
            <input
              type="number"
              min={0}
              max={365}
              value={draft.cacheTtlDays}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  cacheTtlDays: Number(e.target.value) || 0,
                })
              }
              className="w-24 rounded-md ring-1 ring-inset ring-slate-300 px-3 py-1.5"
            />
          </div>
          <div>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.showSourcesByDefault}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    showSourcesByDefault: e.target.checked,
                  })
                }
              />
              <span>Show source detail by default</span>
            </label>
          </div>
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
            >
              Save
            </button>
            <button
              type="button"
              onClick={doClearCache}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
            >
              Clear cache
            </button>
            {clearedMsg && (
              <span className="text-xs text-emerald-700">{clearedMsg}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
