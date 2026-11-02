import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";

import { Toaster } from "@/components/ui/toast";

import {
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
} from "../features/auth/AuthPages";
import { BoardPage } from "../features/boards/BoardPage";
import { HomePage } from "../features/projects/HomePage";
import { ProjectPage } from "../features/projects/ProjectPage";
import { TrashPage } from "../features/projects/TrashPage";
import { ProfilePage } from "../features/settings/ProfilePage";
import { TemplatesPage } from "../features/templates/TemplatesPage";
import { AppShell } from "./AppShell";

const rootRoute = createRootRoute({ component: Outlet });

function PublicLayout() {
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}

const publicRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "public",
  component: PublicLayout,
});
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

export const routeTree = rootRoute.addChildren([
  publicRoute.addChildren([
    createRoute({ getParentRoute: () => publicRoute, path: "/login", component: LoginPage }),
    createRoute({ getParentRoute: () => publicRoute, path: "/register", component: RegisterPage }),
    createRoute({
      getParentRoute: () => publicRoute,
      path: "/forgot-password",
      component: ForgotPasswordPage,
    }),
    createRoute({
      getParentRoute: () => publicRoute,
      path: "/reset-password",
      component: ResetPasswordPage,
    }),
  ]),
  appRoute.addChildren([
    createRoute({ getParentRoute: () => appRoute, path: "/", component: HomePage }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/projects/$projectId",
      component: ProjectPage,
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: "/boards/$boardId",
      component: BoardPage,
      validateSearch: (search: Record<string, unknown>): { builder?: number } =>
        search.builder ? { builder: Number(search.builder) } : {},
    }),
    createRoute({ getParentRoute: () => appRoute, path: "/templates", component: TemplatesPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/trash", component: TrashPage }),
    createRoute({ getParentRoute: () => appRoute, path: "/profile", component: ProfilePage }),
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
