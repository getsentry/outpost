import { useTheme } from "next-themes"
import { Toaster as SonnerToaster, toast } from "sonner"

export function Toaster() {
  const { theme } = useTheme()
  return <SonnerToaster theme={theme as "light" | "dark" | "system"} richColors position="bottom-right" />
}

export function showToast(message: string, type: "success" | "error" | "info" = "success"): void {
  switch (type) {
    case "error":
      toast.error(message)
      break
    case "info":
      toast.info(message)
      break
    default:
      toast.success(message)
  }
}
