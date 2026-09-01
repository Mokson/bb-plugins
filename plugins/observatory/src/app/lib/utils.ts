import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** The shadcn class merger. Vendored source: this plugin owns it. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
