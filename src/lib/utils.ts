import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isWindows(): boolean {
  if (typeof navigator === "undefined") return false
  const s = `${navigator.userAgent} ${navigator.platform ?? ""}`
  return /win/i.test(s)
}
