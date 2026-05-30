import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ASAP design tokens
        primary: {
          DEFAULT: "#3F51B5",
          50: "#EEF0FB",
          100: "#D7DCF4",
          500: "#3F51B5",
          600: "#374699",
          700: "#2E3A80",
        },
        tag: {
          best: "#4F46E5",
          fastest: "#22C55E",
          lowprice: "#F59E0B",
          recommended: "#9333EA",
          sale: "#EF4444",
          free: "#10B981",
          soldout: "#9CA3AF",
        },
        bg: {
          DEFAULT: "#F7F8FA",
          dark: "#1a1a2e",
        },
        ink: {
          primary: "#111827",
          secondary: "#6B7280",
        },
      },
      fontFamily: {
        display: ["var(--font-jakarta)", "Plus Jakarta Sans", "sans-serif"],
        body: ["var(--font-inter)", "Inter", "sans-serif"],
      },
      borderRadius: {
        sm: "6px",
        md: "12px",
        lg: "20px",
      },
      keyframes: {
        "pulse-tag": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(79,70,229,0.5)" },
          "50%": { boxShadow: "0 0 0 6px rgba(79,70,229,0)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-24px)" },
        },
        "float-slow": {
          "0%, 100%": { transform: "translateY(0px) translateX(0px)" },
          "50%": { transform: "translateY(30px) translateX(20px)" },
        },
      },
      animation: {
        "pulse-tag": "pulse-tag 2s infinite",
        float: "float 8s ease-in-out infinite",
        "float-slow": "float-slow 12s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;