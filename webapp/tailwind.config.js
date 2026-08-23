/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx}', './components/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#14171C', // page background
        surface: '#1B1F27', // cards / panels
        surface2: '#232833', // raised surface (chips, inputs)
        line: '#2E3440', // hairline borders
        gold: { DEFAULT: '#E8A93B', dim: '#8A6A2E' }, // brand / the calling ball
        emerald: { DEFAULT: '#2FB67C', dim: '#1F7A54' }, // wins, success
        coral: { DEFAULT: '#E8615D', dim: '#8A3B39' }, // withdrawals, danger
        ivory: '#E7E9EE', // primary text
        mute: '#8B93A3' // secondary text
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace']
      },
      borderRadius: {
        card: '18px',
        chip: '10px'
      },
      keyframes: {
        popIn: { '0%': { transform: 'scale(0.6)', opacity: 0 }, '60%': { transform: 'scale(1.08)', opacity: 1 }, '100%': { transform: 'scale(1)' } },
        slideIn: { '0%': { transform: 'translateX(12px)', opacity: 0 }, '100%': { transform: 'translateX(0)', opacity: 1 } }
      },
      animation: {
        popIn: 'popIn 420ms cubic-bezier(.2,.8,.3,1)',
        slideIn: 'slideIn 260ms ease-out'
      }
    }
  },
  plugins: []
};
