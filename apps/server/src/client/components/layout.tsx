import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
	House,
	Lightning,
	SignOut,
	List,
} from "@phosphor-icons/react";
import { useSession } from "@/client/lib/queries";
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
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

const NAV_ITEMS = [
	{ to: "/", label: "Dashboard", icon: House },
	{ to: "/events", label: "Webhook Events", icon: Lightning },
];

function AppSidebar() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: session, isLoading } = useSession();

	const handleLogout = async () => {
		try {
			await fetch("/auth/sign-out", {
				method: "POST",
				credentials: "include",
			});
		} finally {
			queryClient.clear();
			navigate("/login");
		}
	};

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" tooltip="Outpost">
							<div className="flex aspect-square size-8 items-center justify-center bg-primary text-primary-foreground">
								<List className="size-4" weight="bold" />
							</div>
							<div className="grid flex-1 text-left leading-tight">
								<span className="truncate text-sm font-semibold">Outpost</span>
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
				<Separator />
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" tooltip={session?.user.name ?? "User"}>
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
								</>
							)}
						</SidebarMenuButton>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarMenuButton tooltip="Sign out" onClick={handleLogout}>
							<SignOut />
							<span>Sign out</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}

export default function Layout() {
	return (
		<SidebarProvider>
			<AppSidebar />
			<SidebarInset>
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
					<SidebarTrigger className="-ml-1" />
					<Separator orientation="vertical" className="mr-2 !h-4" />
					<span className="text-sm text-muted-foreground">Webhook Events Dashboard</span>
				</header>
				<div className="flex-1 overflow-auto p-6">
					<Outlet />
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}
