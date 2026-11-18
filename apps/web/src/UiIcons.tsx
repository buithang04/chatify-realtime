import type { ReactNode } from "react";

type IconName = "mic" | "micOff" | "headphones" | "volume" | "volumeOff" | "settings" | "chevron" | "lock" | "unlock";

const paths: Record<IconName, ReactNode> = {
  mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8" /></>,
  micOff: <><path d="m3 3 18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.9-.8M5 10a7 7 0 0 0 12 5M19 10a7 7 0 0 1-1 3.6M12 17v5m-4 0h8" /></>,
  headphones: <><path d="M3 14v-3a9 9 0 0 1 18 0v3M3 14v4a2 2 0 0 0 2 2h2v-7H5a2 2 0 0 0-2 1Zm18 0v4a2 2 0 0 1-2 2h-2v-7h2a2 2 0 0 1 2 1Z" /></>,
  volume: <><path d="M4 9v6h4l5 4V5L8 9H4Zm13-1a6 6 0 0 1 0 8m2-11a10 10 0 0 1 0 14" /></>,
  volumeOff: <><path d="M4 9v6h4l5 4V5L8 9H4Zm13 0 5 6m0-6-5 6" /></>,
  settings: <><path d="M10.4 2h3.2l.5 2.2a8 8 0 0 1 1.6.7l2-.9 2.3 2.3-.9 2a8 8 0 0 1 .7 1.6l2.2.5v3.2l-2.2.5a8 8 0 0 1-.7 1.6l.9 2-2.3 2.3-2-.9a8 8 0 0 1-1.6.7l-.5 2.2h-3.2l-.5-2.2a8 8 0 0 1-1.6-.7l-2 .9-2.3-2.3.9-2a8 8 0 0 1-.7-1.6L2 13.6v-3.2l2.2-.5a8 8 0 0 1 .7-1.6l-.9-2L6.3 4l2 .9a8 8 0 0 1 1.6-.7L10.4 2Z" /><circle cx="12" cy="12" r="3" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7-2.6M12 14v3" /></>,
};

export function UiIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
