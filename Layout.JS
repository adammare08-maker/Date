import './globals.css';

export const metadata = {
  title: 'Dette — Rencontres express',
  description: 'Choisis un lieu. Montre-toi. Rencontre.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <head>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
