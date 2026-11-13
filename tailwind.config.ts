import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        verity: {
          DEFAULT: "var(--verity)",
          hover: "var(--verity-hover)",
          press: "var(--verity-press)",
          fg: "var(--verity-fg)",
          soft: "var(--verity-soft)",
          "soft-hi": "var(--verity-soft-hi)",
          border: "var(--verity-border)",
        },

        gold: {
          DEFAULT: "var(--gold)",
          ink: "var(--gold-ink)",
          soft: "var(--gold-soft)",
          border: "var(--gold-border)",
          "on-soft": "var(--on-gold-soft)",
        },
        ok: {
          DEFAULT: "var(--ok)",
          soft: "var(--ok-soft)",
          border: "var(--ok-border)",
        },
        warn: {
          DEFAULT: "var(--warn)",
          soft: "var(--warn-soft)",
          border: "var(--warn-border)",
        },
        bad: {
          DEFAULT: "var(--bad)",
          soft: "var(--bad-soft)",
          border: "var(--bad-border)",
        },
        ai: {
          DEFAULT: "var(--ai)",
          soft: "var(--ai-soft)",
          border: "var(--ai-border)",
        },
        teal: {
          DEFAULT: "var(--teal)",
          soft: "var(--teal-soft)",
          border: "var(--teal-border)",
        },
        mute: {
          DEFAULT: "var(--mute)",
          soft: "var(--mute-soft)",
          border: "var(--mute-border)",
        },
        learn: {
          DEFAULT: "var(--learn)",
          glow: "var(--learn-glow)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
          elevated: "var(--elevated)",
          inset: "var(--inset)",
          paper: "var(--paper)",
        },
        text: {
          1: "var(--text-1)",
          2: "var(--text-2)",
          3: "var(--text-3)",
          disabled: "var(--text-disabled)",
        },
        border: {
          subtle: "var(--border-subtle)",
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Be Vietnam Pro", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "monospace"],
      },
      borderRadius: {
        xs: "var(--r-xs)",
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
        full: "var(--r-full)",
      },
      boxShadow: {
        sm: "var(--sh-sm)",
        md: "var(--sh-md)",
        pop: "var(--sh-pop)",
        drawer: "var(--sh-drawer)",
      },
      keyframes: {
        "learn-ring": {
          "0%": { boxShadow: "0 0 0 0 var(--learn-glow)", borderColor: "var(--learn)" },
          "70%": { boxShadow: "0 0 0 4px var(--learn-glow)", borderColor: "var(--learn)" },
          "100%": { boxShadow: "0 0 0 0 rgba(0,0,0,0)" },
        },
        mmpop: {
          "0%": { transform: "scale(0.94)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        mmshimmer: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "0.9" },
        },
        spin: {
          to: { transform: "rotate(360deg)" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideLeft: {
          "0%": { opacity: "0", transform: "translateX(16px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "overlay-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        "learn-ring": "learn-ring 1000ms cubic-bezier(0.16, 1, 0.3, 1) forwards",
        pop: "mmpop 180ms ease-out forwards",
        shimmer: "mmshimmer 1.4s ease-in-out infinite",
        spin: "spin 900ms linear infinite",
        fadeIn: "fadeIn 180ms ease-out forwards",
        slideLeft: "slideLeft 220ms cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "overlay-in": "overlay-in 180ms ease-out forwards",
      },
      transitionDuration: {
        instant: "var(--duration-instant)",
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)",
        moderate: "var(--duration-moderate)",
        slow: "var(--duration-slow)",
        deliberate: "var(--duration-deliberate)",
      },
      transitionTimingFunction: {
        standard: "var(--ease-standard)",
        decelerate: "var(--ease-decelerate)",
        accelerate: "var(--ease-accelerate)",
        "spring-snappy": "var(--ease-spring-snappy)",
        "spring-gentle": "var(--ease-spring-gentle)",
      },
    },
  },
  plugins: [],
};

export default config;
