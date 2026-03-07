export function Header() {
  const apiUrl = import.meta.env.VITE_API_URL || "//api.localhost";
  const appUrl = apiUrl.includes("localhost")
    ? "//localhost:4002"
    : apiUrl.replace(/\/\/api\./, "//app.");

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-neutral-200 text-xs">
      <div className="flex items-center gap-1.5 text-neutral-900 font-medium">
        <span>numavm</span>
        <span className="text-neutral-400">/</span>
        <span>admin</span>
      </div>
      <a
        href={appUrl}
        className="text-neutral-400 hover:text-neutral-600 underline underline-offset-4 text-xs"
      >
        app dashboard
      </a>
    </header>
  );
}
