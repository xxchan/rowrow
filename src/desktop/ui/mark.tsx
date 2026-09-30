// rowrow's mark (src/web's RowrowMark), for the app's own pages.
export function RowrowMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M3 16c3-2 6-2 9 0s6 2 9 0" />
      <path d="M7 4l5 9" />
      <path d="M13 4l5 9" />
    </svg>
  );
}
