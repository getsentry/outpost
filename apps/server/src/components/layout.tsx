import { CaretUpDown, House, Lightning, List, Monitor, Moon, Robot, SignOut, Sun } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useSession } from "@/client/lib/queries"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { authClient } from "@/lib/endpoint"

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: House },
  { to: "/events", label: "Webhook Events", icon: Lightning },
  { to: "/runs", label: "Agent runs", icon: Robot },
]

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

function AppSidebar() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { theme, setTheme } = useTheme()
  const { data: session, isLoading } = useSession()

  const handleLogout = async () => {
    try {
      await authClient.signOut()
    } finally {
      queryClient.clear()
      navigate("/login")
    }
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Outpost"
              className="cursor-default hover:bg-transparent hover:text-current active:bg-transparent active:text-current"
            >
              <div className="flex aspect-square size-8 items-center justify-center bg-primary text-primary-foreground">
                <List className="size-4" weight="bold" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-mono text-sm font-semibold">Outpost</span>
                <span className="truncate text-xs text-muted-foreground">Dashboard</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <NavLink to={item.to} end={item.to === "/"}>
                    {({ isActive }) => (
                      <SidebarMenuButton isActive={isActive} tooltip={item.label}>
                        <item.icon weight={isActive ? "fill" : "regular"} />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    )}
                  </NavLink>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger render={<SidebarMenuButton size="lg" tooltip={session?.user.name ?? "User"} />}>
                {isLoading ? (
                  <>
                    <Skeleton className="size-8 rounded-full" />
                    <div className="grid flex-1 gap-1">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-2.5 w-28" />
                    </div>
                  </>
                ) : (
                  <>
                    <Avatar className="size-8">
                      <AvatarImage src={session?.user.image ?? undefined} alt={session?.user.name} />
                      <AvatarFallback className="text-xs">
                        {session?.user.name?.charAt(0).toUpperCase() ?? "?"}
                      </AvatarFallback>
                    </Avatar>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate text-sm">{session?.user.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{session?.user.email}</span>
                    </div>
                    <CaretUpDown className="ml-auto size-4 text-muted-foreground" />
                  </>
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{session?.user.name}</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Sun className="size-4" />
                      Theme
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {THEME_OPTIONS.map((option) => (
                        <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
                          <option.icon className="size-4" weight={theme === option.value ? "fill" : "regular"} />
                          {option.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout}>
                  <SignOut className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

// ---------------------------------------------------------------------------
// Breadcrumbs — derives segments from the current URL path.
// ---------------------------------------------------------------------------

function Breadcrumbs() {
  const location = useLocation()
  const [searchParams] = useSearchParams()

  const segments = location.pathname.split("/").filter(Boolean)

  // Build crumb list: [{label, href}]
  const crumbs: { label: string; href?: string }[] = [{ label: "Dashboard", href: "/" }]

  if (segments[0] === "events") {
    crumbs.push({ label: "Webhook Events", href: "/events" })
    if (segments[1]) {
      // /events/:id
      const id = segments[1]
      crumbs.push({ label: `Event ${id.slice(0, 8)}…` })
    }
  } else if (segments[0] === "runs") {
    crumbs.push({ label: "Agent Runs", href: "/runs" })
    if (segments.length > 1) {
      // /runs/detail?key=... or /runs/:entityKey
      const key = searchParams.get("key") ?? (segments[1] !== "detail" ? segments[1] : null)
      crumbs.push({ label: key ?? "Run Detail" })
    }
  }

  // Only the last segment is non-clickable
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1
        return (
          <span key={crumb.href ?? crumb.label} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted-foreground/50">/</span>}
            {isLast || !crumb.href ? (
              <span className="max-w-48 truncate font-medium text-foreground">{crumb.label}</span>
            ) : (
              <Link to={crumb.href} className="text-muted-foreground transition-colors hover:text-foreground">
                {crumb.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}

export default function Layout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* h-svh + overflow-hidden gives the inset a definite height so pages can
          own their own internal scrolling (e.g. the container detail page only
          scrolls its messages list, keeping the header/sidebar pinned). */}
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 !h-4" />
          <Breadcrumbs />
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto p-6">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
