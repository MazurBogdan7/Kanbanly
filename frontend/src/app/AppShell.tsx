import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  FolderKanban,
  LayoutTemplate,
  LogOut,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIncomingInvites } from "@/features/projects/Inbox";

import { Button, cx, Modal, Skeleton } from "@/components/ui";
import { Toaster } from "@/components/ui/toast";
import { useT, type MessageKey } from "@/i18n";
import { api } from "@/lib/api/client";
import type { SearchHit } from "@/lib/api/types";
import { useHotkeys } from "@/lib/hotkeys";

import { useMe, useSignOut } from "../features/auth/session";

const NAV: { to: string; label: MessageKey; icon: typeof FolderKanban }[] = [
  { to: "/", label: "app.home", icon: FolderKanban },
  { to: "/templates", label: "app.templates", icon: LayoutTemplate },
  { to: "/trash", label: "app.trash", icon: Trash2 },
  { to: "/profile", label: "app.profile", icon: UserRound },
];
const ADMIN_NAV = { to: "/admin", label: "app.admin" as MessageKey, icon: ShieldCheck };

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function CommandPalette({
  open,
  onOpenChange,
  onHotkeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onHotkeys: () => void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const debounced = useDebounced(query.trim(), 150);
  const hits = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<SearchHit[]>("/search", { q: debounced }),
    enabled: open && debounced.length > 0,
  });
  const commands = useMemo(
    () => [
      { label: t("palette.cmdHome"), run: () => void navigate({ to: "/" }) },
      { label: t("palette.cmdTemplates"), run: () => void navigate({ to: "/templates" }) },
      { label: t("palette.cmdProfile"), run: () => void navigate({ to: "/profile" }) },
      { label: t("palette.cmdTrash"), run: () => void navigate({ to: "/trash" }) },
      { label: t("palette.cmdHotkeys"), run: onHotkeys },
    ],
    [navigate, onHotkeys, t],
  );
  const filtered = commands.filter((command) =>
    command.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  // Результаты старого запроса не должны ловить Enter, пока поиск догоняет ввод.
  const fresh = debounced === query.trim();
  const results = (fresh ? (hits.data ?? []) : []).map((hit) => ({
    label: hit.title,
    hint: hit.subtitle,
    run: () => void navigate({ to: "/boards/$boardId", params: { boardId: hit.board_id } }),
  }));
  const items: { label: string; hint?: string; run: () => void }[] = [...results, ...filtered];
  const choose = (position: number) => {
    const item = items[position];
    if (!item) return;
    onOpenChange(false);
    setQuery("");
    item.run();
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("app.search")} width={560}>
      <input
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-label={t("palette.placeholder")}
        placeholder={t("palette.placeholder")}
        className="mb-2 h-10 w-full rounded-sm border border-line-strong bg-panel px-3 text-sm text-ink"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setIndex((value) => Math.min(value + 1, items.length - 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setIndex((value) => Math.max(value - 1, 0));
          }
          if (event.key === "Enter") choose(index);
        }}
      />
      <ul
        id="palette-list"
        role="listbox"
        aria-label={t("palette.groupResults")}
        className="max-h-80 overflow-y-auto"
      >
        {items.map((item, position) => (
          <li key={`${item.label}-${position}`} role="option" aria-selected={position === index}>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => choose(position)}
              className={cx(
                "flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm",
                position === index ? "bg-brand-soft" : "hover:bg-raised",
              )}
            >
              <span className="truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 text-xs text-ink-soft">{item.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 && <p className="p-2 text-sm text-ink-soft">{t("palette.empty")}</p>}
    </Modal>
  );
}

function HotkeysHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  const rows: [string, MessageKey][] = [
    ["N", "hotkeys.new"],
    ["/ · Ctrl+K", "hotkeys.palette"],
    ["← ↑ → ↓", "hotkeys.nav"],
    ["E · Enter", "hotkeys.edit"],
    [t("hotkeys.space"), "dnd.instructions"],
    ["Esc", "hotkeys.close"],
    ["Ctrl+Z", "hotkeys.undo"],
    ["?", "hotkeys.help"],
  ];
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t("hotkeys.title")} width={460}>
      <dl className="grid gap-2 text-sm">
        {rows.map(([keys, label]) => (
          <div key={keys} className="flex items-center justify-between gap-4">
            <dt className="text-ink-soft">{t(label)}</dt>
            <dd>
              <kbd className="rounded-sm border border-line-strong bg-raised px-1.5 py-0.5 font-mono text-xs">
                {keys}
              </kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

export function AppShell() {
  const { t } = useT();
  const me = useMe();
  const nav = me.data?.is_admin ? [...NAV, ADMIN_NAV] : NAV;
  const invites = useIncomingInvites(!!me.data);
  const pending = invites.data?.length ?? 0;
  // Значок на «Профиле»: в профиле лежат входящие приглашения.
  const badge = (to: string) =>
    to === "/profile" && pending > 0 ? (
      <span
        className="rounded-full bg-brand px-1.5 text-[10px] leading-4 font-semibold text-white"
        aria-label={t("inbox.badge", { count: pending })}
      >
        {pending}
      </span>
    ) : null;
  const signOut = useSignOut();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const href = useRouterState({ select: (state) => state.location.href });
  // Адрес возврата фиксируется в момент потери сессии: во время перехода оболочка ещё
  // перерисовывается с адресом страницы входа, и без фиксации переадресация зациклится.
  const returnTo = useRef<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);

  useHotkeys({
    "/": () => setPalette(true),
    "mod+k": () => setPalette(true),
    "?": () => setHelp(true),
  });

  if (me.isPending) {
    return (
      <div className="p-6" aria-busy>
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (!me.data) {
    returnTo.current ??= href;
    const next = returnTo.current;
    return <Navigate to="/login" search={next === "/" ? {} : { next }} replace />;
  }
  returnTo.current = null;

  const logout = () => void api.post("/auth/logout").finally(() => void signOut());

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-panel focus:p-2"
      >
        {t("app.skip")}
      </a>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
        <Link to="/" className="mr-3 font-bold text-brand">
          {t("app.name")}
        </Link>
        <nav aria-label={t("app.nav")} className="hidden gap-1 md:flex">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              aria-current={path === to ? "page" : undefined}
              className={cx(
                "flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm transition-colors",
                path === to
                  ? "bg-brand-soft text-ink"
                  : "text-ink-soft hover:bg-raised hover:text-ink",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {t(label)}
              {badge(to)}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("app.search")}
            onClick={() => setPalette(true)}
          >
            <Search className="size-3.5" aria-hidden />
            <span className="hidden sm:inline">{t("app.search")}</span>
            <kbd className="hidden font-mono text-xs sm:inline">Ctrl K</kbd>
          </Button>
          <Button variant="ghost" size="icon" aria-label={t("app.logout")} onClick={logout}>
            <LogOut className="size-4" aria-hidden />
          </Button>
        </div>
      </header>
      <main id="main" className="flex min-h-0 flex-1 flex-col overflow-auto pb-14 md:pb-0">
        <Outlet />
      </main>
      <nav
        aria-label={t("app.nav")}
        className="fixed inset-x-0 bottom-0 z-30 flex h-14 border-t border-line bg-panel md:hidden"
      >
        {nav.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            aria-current={path === to ? "page" : undefined}
            className={cx(
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px]",
              path === to ? "text-brand" : "text-ink-soft",
            )}
          >
            <span className="relative">
              <Icon className="size-5" aria-hidden />
              <span className="absolute -top-1.5 -right-3">{badge(to)}</span>
            </span>
            {t(label)}
          </Link>
        ))}
      </nav>
      <CommandPalette open={palette} onOpenChange={setPalette} onHotkeys={() => setHelp(true)} />
      <HotkeysHelp open={help} onOpenChange={setHelp} />
      <Toaster />
    </div>
  );
}
