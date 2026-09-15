export default function Loading() {
  return (
    <div aria-busy="true" aria-label="טוען…" className="flex flex-col gap-4">
      <div className="h-7 w-40 animate-pulse rounded-xl bg-line" />
      <div className="h-14 animate-pulse rounded-2xl bg-line" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-2xl bg-line" />
      ))}
    </div>
  );
}
