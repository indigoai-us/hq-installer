import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 rounded-full",
  {
    variants: {
      variant: {
        default: "bg-white text-black hover:bg-zinc-100",
        secondary:
          "bg-white/5 border border-white/10 text-white hover:border-white/25",
        ghost: "hover:bg-white/5 text-zinc-400 hover:text-white",
        link: "text-zinc-400 underline-offset-4 hover:underline hover:text-white",
      },
      size: {
        default: "h-10 px-6 py-2 text-sm",
        sm: "h-8 px-4 text-xs",
        lg: "h-12 px-8 text-base",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> &
    VariantProps<typeof buttonVariants>
>(({ className, variant, size, ...props }, ref) => {
  return (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  );
});
Button.displayName = "Button";

export { Button, buttonVariants };
