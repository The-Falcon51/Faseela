/** Tailwind build config (replaces the Play CDN runtime; review F-06). Keep in sync with design tokens. */
module.exports = {
  content: ['./public/index.html', './public/*.mjs', './public/legal/*.html', './public/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Cairo', 'sans-serif']
      },
      colors: {
        olive: {
          50: '#f6f7f2', 100: '#ebede2', 200: '#d7dbc5', 300: '#bcc3a1', 400: '#9fa87c', 500: '#848f5d',
          600: '#677146', 700: '#505838', 800: '#424830', 900: '#383d2a', 950: '#1c2013'
        },
        terracotta: { 500: '#d96b43', 600: '#be532b', 700: '#9d3f1d' }
      }
    }
  }
};
