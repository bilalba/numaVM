export function StatsCard({
  label,
  value,
  subtitle,
  dot,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
  dot?: string;
}) {
  return (
    <div className="border border-neutral-200 bg-panel-chat p-4">
      <div className="text-xs text-neutral-500 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
        <span className="text-2xl font-semibold">{value}</span>
      </div>
      {subtitle && (
        <div className="text-xs text-neutral-400 mt-1">{subtitle}</div>
      )}
    </div>
  );
}
