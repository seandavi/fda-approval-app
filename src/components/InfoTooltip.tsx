import { useId } from "react";

interface Props {
  text: string;
  side?: "top" | "bottom";
}

export function InfoTooltip({ text, side = "top" }: Props) {
  const id = useId();
  const sideClasses =
    side === "top"
      ? "bottom-full mb-1 left-1/2 -translate-x-1/2"
      : "top-full mt-1 left-1/2 -translate-x-1/2";

  return (
    <span className="relative inline-block group ml-1 align-middle">
      <button
        type="button"
        aria-describedby={id}
        tabIndex={0}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 text-[10px] font-semibold text-slate-600 hover:bg-violet-100 hover:text-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-400"
      >
        i
      </button>
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute z-20 ${sideClasses} hidden group-hover:block group-focus-within:block whitespace-normal w-64 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-normal text-white shadow-lg`}
      >
        {text}
      </span>
    </span>
  );
}
