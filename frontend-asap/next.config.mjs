/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "i.pravatar.cc" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      // Ticketmaster Discovery event images
      { protocol: "https", hostname: "**.ticketm.net" },
      { protocol: "https", hostname: "**.ticketmaster.com" },
      { protocol: "https", hostname: "**.tmol.co" },
    ],
  },
};

export default nextConfig;